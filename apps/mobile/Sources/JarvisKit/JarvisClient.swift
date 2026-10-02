import Foundation
import CryptoKit

// MARK: - Modeller (speiler backend-kontraktene i packages/contracts)

public struct JarvisIdentity: Codable, Sendable {
    public var person_id: String
    public var tenant_id: String
    public var device_id: String
    public var memory_space: String
    public var channel: String
    public init(person: String, tenant: String, device: String, space: String = "personal", channel: String = "mobile") {
        person_id = person; tenant_id = tenant; device_id = device; memory_space = space; self.channel = channel
    }
}

public struct ChatReply: Codable, Sendable {
    public let reply: String
    public let routed: String
    public let session_id: String
    public let task_id: String?
}

/// REMEDIERING DEL 2 (JARVIS-051): godkjenningen er kryptografisk bundet til verktøy, handling,
/// parameter-hash, tenant, forespørrende person, godkjennende person, utstedelse og utløp (maks 5 min).
/// UVERIFISERT på Apple-maskinvare (ingen Swift-toolchain i remedieringsmiljøet) - se APPLE_PHASE8_CHECKLIST.
public struct SignedApproval: Codable, Sendable {
    public let tool_id: String
    public let action: String
    public let parameters_hash: String
    public let tenant_id: String
    public let person_id: String
    public let approver_person_id: String
    public let approving_device_id: String
    public let issued_at: String
    public let expires_at: String
    public let nonce: String
    public let signature: String
}

// MARK: - Enhetsnøkler
// Ed25519 (Curve25519) i Keychain: kompatibel med backendens verifisering i dag.
// Secure Enclave (P-256) er forberedt, men krever ECDSA-støtte i backendens
// approval-verifier først - se APPLE_PHASE8_CHECKLIST.

public enum DeviceKeys {
    static let tag = "com.tsworkflow.jarvis.devicekey"

    public static func loadOrCreate() throws -> Curve25519.Signing.PrivateKey {
        if let data = KeychainStore.read(tag: tag) {
            return try Curve25519.Signing.PrivateKey(rawRepresentation: data)
        }
        let key = Curve25519.Signing.PrivateKey()
        try KeychainStore.write(tag: tag, data: key.rawRepresentation)
        return key
    }

    /// PEM (SPKI) for registrering mot POST /devices/register
    public static func publicKeyPem(_ key: Curve25519.Signing.PrivateKey) -> String {
        var der = Data([0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00])
        der.append(key.publicKey.rawRepresentation)
        let b64 = der.base64EncodedString(options: [.lineLength64Characters, .endLineWithLineFeed])
        return "-----BEGIN PUBLIC KEY-----\n\(b64)\n-----END PUBLIC KEY-----\n"
    }
}

enum KeychainStore {
    static func read(tag: String) -> Data? {
        let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword,
                                    kSecAttrAccount as String: tag,
                                    kSecReturnData as String: true]
        var out: CFTypeRef?
        return SecItemCopyMatching(query as CFDictionary, &out) == errSecSuccess ? out as? Data : nil
    }
    static func write(tag: String, data: Data) throws {
        let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword,
                                    kSecAttrAccount as String: tag,
                                    kSecValueData as String: data,
                                    kSecAttrAccessible as String: kSecAttrAccessibleWhenUnlockedThisDeviceOnly]
        SecItemDelete(query as CFDictionary)
        guard SecItemAdd(query as CFDictionary, nil) == errSecSuccess else {
            throw NSError(domain: "Keychain", code: -1)
        }
    }
}

// MARK: - Godkjenningssignering (klasse D)
// Kanonisk JSON MÅ matche backendens approvalSigningBytes (packages/contracts/src/approval.ts):
// nøkler i SORTERT rekkefølge: action, approver_person_id, approving_device_id, expires_at,
// issued_at, nonce, parameters_hash, person_id, tenant_id, tool_id.
// `parameters_hash` = SHA-256 (hex) av parametrenes kanoniske JSON (sorterte nøkler).

public enum ApprovalSigner {
    public static func sign(toolId: String, action: String, parameters: [String: String], tenantId: String,
                            personId: String, approverPersonId: String, deviceId: String,
                            validSeconds: TimeInterval, key: Curve25519.Signing.PrivateKey) throws -> SignedApproval {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let issued = formatter.string(from: Date())
        // Serveren avviser levetid over 5 minutter - klienten kapper til samme tak.
        let expires = formatter.string(from: Date().addingTimeInterval(min(validSeconds, 300)))
        let nonce = "nonce-\(UUID().uuidString.lowercased())"
        let sortedParams = parameters.keys.sorted()
            .map { "\(jsonString($0)):\(jsonString(parameters[$0]!))" }.joined(separator: ",")
        let parametersHash = SHA256.hash(data: Data("{\(sortedParams)}".utf8)).map { String(format: "%02x", $0) }.joined()
        let canonical = "{\"action\":\(jsonString(action)),\"approver_person_id\":\(jsonString(approverPersonId)),\"approving_device_id\":\(jsonString(deviceId)),\"expires_at\":\(jsonString(expires)),\"issued_at\":\(jsonString(issued)),\"nonce\":\(jsonString(nonce)),\"parameters_hash\":\(jsonString(parametersHash)),\"person_id\":\(jsonString(personId)),\"tenant_id\":\(jsonString(tenantId)),\"tool_id\":\(jsonString(toolId))}"
        let signature = try key.signature(for: Data(canonical.utf8)).base64EncodedString()
        return SignedApproval(tool_id: toolId, action: action, parameters_hash: parametersHash, tenant_id: tenantId,
                              person_id: personId, approver_person_id: approverPersonId, approving_device_id: deviceId,
                              issued_at: issued, expires_at: expires, nonce: nonce, signature: signature)
    }
    static func jsonString(_ s: String) -> String {
        let data = try! JSONEncoder().encode(s)
        return String(data: data, encoding: .utf8)!
    }
}

// MARK: - API-klient
// Reconnect/offline uten doble handlinger: hver sendte melding får en lokal
// utterance-id; en melding som er bekreftet sendt re-sendes aldri (persistert
// i UserDefaults). Ingen provider-secrets i klienten - kun enhetsauth.

public actor JarvisClient {
    let baseURL: URL
    public var identity: JarvisIdentity
    private var completedUtterances: Set<String>
    /// D-131 (uavhengig arkitektkontroll av PR #79, funn 1): det betrodde
    /// BÆRER-BEVISET fra en vellykket `authorizeSession()`.
    ///
    /// D-130-runden holdt her et `session_id`. Reviewen påviste at en
    /// sesjons-ID er samtalekontinuitet - bevisst delt mellom personens
    /// kanaler, med en `last_device_id` som overskrives ved hvert kanalbytte -
    /// og derfor strukturelt ute av stand til å dokumentere hvilken enhet som
    /// står bak et kall, om nøkkelen er tilbakekalt, eller når autoriteten
    /// utløper. Et grant er bundet til NØYAKTIG denne enheten, dette scopet og
    /// denne kanalen, og har et utløp.
    private var grantToken: String?
    /// Absolutt utløp (epoch ms) for `grantToken`. Håndheves server-side ved
    /// hvert kall; her brukes den kun til å re-autorisere i tide.
    private var grantExpiresAtMs: Double?

    public init(baseURL: URL, identity: JarvisIdentity) {
        self.baseURL = baseURL
        self.identity = identity
        completedUtterances = Set(UserDefaults.standard.stringArray(forKey: "jarvis.completed") ?? [])
    }

    /// Remediering del 2: kontrollrutene tar KUN et grant (aldri en identitet i kroppen).
    public func currentGrantToken() throws -> String {
        guard let grantToken else { throw NSError(domain: "Jarvis", code: 401, userInfo: [NSLocalizedDescriptionKey: "grant_required"]) }
        return grantToken
    }

    public func health() async throws -> Bool {
        let (_, response) = try await URLSession.shared.data(from: baseURL.appendingPathComponent("health"))
        return (response as? HTTPURLResponse)?.statusCode == 200
    }

    /// D-131 funn 1: `/chat` godtar ikke ETT ENESTE identitetsbærende felt
    /// lenger - kroppen er `{ grant_token, message }` og intet annet.
    /// `tenant_id`/`memory_space`/`channel` er fjernet fordi serveren leser dem
    /// ut av grant-raden; å sende dem ville blitt avvist som
    /// `malformed_request`.
    public func chat(_ message: String, utteranceId: String = UUID().uuidString) async throws -> ChatReply? {
        guard !completedUtterances.contains(utteranceId) else { return nil } // aldri dobbel handling
        guard let grantToken else {
            throw NSError(domain: "Jarvis", code: -2,
                          userInfo: [NSLocalizedDescriptionKey: "not_authorized: call authorizeSession first"])
        }
        let reply: ChatReply = try await post("chat", body: ["grant_token": grantToken, "message": message])
        completedUtterances.insert(utteranceId)
        UserDefaults.standard.set(Array(completedUtterances), forKey: "jarvis.completed")
        return reply
    }

    /// Er grantet fortsatt gyldig lenge nok til å brukes? 30 s margin så vi
    /// ikke sender et bevis som utløper mens forespørselen er underveis.
    public var hasUsableGrant: Bool {
        guard grantToken != nil, let expiry = grantExpiresAtMs else { return false }
        return expiry - 30_000 > Date().timeIntervalSince1970 * 1000
    }

    /// D-131 (uavhengig arkitektkontroll av PR #79, funn 2): innrullering og
    /// nøkkelrotasjon krever nå EKSPLISITT eier-/bootstrap-autoritet.
    ///
    /// Den gamle implementasjonen sendte en SELVOPPGITT `identity` med
    /// `auth_strength: "active"`, og serveren autoriserte den med
    /// `resolveIdentity()` - som verifiserer EKSISTENS, ikke AUTENTISERING. En
    /// nettverksklient som kjente de (ikke hemmelige) ID-ene kunne dermed
    /// skrive sin EGEN offentlige nøkkel og deretter «bevise» enheten med sin
    /// egen private nøkkel.
    ///
    /// Nå må kalleren legge fram ett av to bevis:
    ///   - `enrollWithExistingDevice(...)` - proof-of-possession fra en enhet
    ///     som allerede er innrullert på samme person (også veien for
    ///     nøkkelrotasjon på denne enheten selv), eller
    ///   - `enrollWithTicket(...)` - en engangs-billett fra en lokal
    ///     eier-handling (`pnpm --filter @jarvis/api enroll-ticket`), som er
    ///     den eneste veien inn for aller FØRSTE enhet.
    public func enrollWithTicket(kind: String, publicKeyPem: String, ticket: String) async throws {
        try await enroll(kind: kind, publicKeyPem: publicKeyPem,
                         enrollment: ["kind": "enrollment_ticket", "ticket": ticket])
    }

    /// Innrullering/rotasjon autorisert av en ALLEREDE innrullert enhet. Send
    /// `authorizingDeviceId` = denne enhetens egen id for ren nøkkelrotasjon.
    public func enrollWithExistingDevice(
        kind: String,
        publicKeyPem: String,
        authorizingDeviceId: String,
        authorizingKey: Curve25519.Signing.PrivateKey
    ) async throws {
        let (challenge, signature) = try await signChallenge(key: authorizingKey, deviceId: authorizingDeviceId)
        try await enroll(kind: kind, publicKeyPem: publicKeyPem, enrollment: [
            "kind": "device_proof", "authorizing_device_id": authorizingDeviceId,
            "challenge": challenge, "signature": signature
        ])
    }

    private func enroll(kind: String, publicKeyPem: String, enrollment: [String: Any]) async throws {
        struct EnrollResponse: Codable { let ok: Bool }
        let result: EnrollResponse = try await post("devices/register", body: [
            "tenant_id": identity.tenant_id,
            "person_id": identity.person_id,
            "device": ["device_id": identity.device_id, "kind": kind, "public_key_pem": publicKeyPem],
            "enrollment": enrollment
        ])
        guard result.ok else {
            throw NSError(domain: "Jarvis", code: -4,
                          userInfo: [NSLocalizedDescriptionKey: "device_enrollment_failed"])
        }
    }

    /// Lavnivå-primitiv: løser kun challenge-/signatur-runden mot
    /// `/devices/challenge`, uten å utstede noen sesjon. Gjenbrukt av
    /// `authorizeSession()` under - ingen duplisert signeringslogikk.
    private func signChallenge(
        key: Curve25519.Signing.PrivateKey,
        deviceId: String? = nil
    ) async throws -> (challenge: String, signature: String) {
        struct Challenge: Codable { let challenge: String }
        let challenge: Challenge = try await post("devices/challenge", body: ["device_id": deviceId ?? identity.device_id])
        let signature = try key.signature(for: Data(challenge.challenge.utf8)).base64EncodedString()
        return (challenge.challenge, signature)
    }

    public func proveDevice(key: Curve25519.Signing.PrivateKey) async throws -> Bool {
        let (challenge, signature) = try await signChallenge(key: key)
        struct Verified: Codable { let verified: Bool }
        let result: Verified = try await post("devices/challenge/verify", body: [
            "tenant_id": identity.tenant_id, "device_id": identity.device_id,
            "challenge": challenge, "signature": signature
        ])
        return result.verified
    }

    /// D-131 funn 1: den ENESTE veien til et gyldig `grant_token` for `chat()`.
    /// Beviser enhetsbesittelse (samme challenge-/signatur-runde som
    /// `proveDevice()`, via `signChallenge()`) og binder resultatet til
    /// `/session/authorize` - IKKE bare `/devices/challenge/verify`, som kun
    /// rapporterer `auth_strength` og aldri utsteder noen autoritet.
    ///
    /// Returnerer grantets `session_id` (SAMTALEKONTINUITET, til korrelasjon/
    /// visning) - selve beviset holdes internt og sendes aldri av kalleren.
    @discardableResult
    public func authorizeSession(key: Curve25519.Signing.PrivateKey) async throws -> String {
        let (challenge, signature) = try await signChallenge(key: key)
        struct Grant: Codable { let grant_token: String; let expires_at_ms: Double; let session_id: String }
        struct SessionAuthorizeResponse: Codable { let ok: Bool; let grant: Grant? }
        let result: SessionAuthorizeResponse = try await post("session/authorize", body: [
            "channel": identity.channel, "person_id": identity.person_id, "tenant_id": identity.tenant_id,
            "device_id": identity.device_id, "memory_space": identity.memory_space,
            "device_proof": ["challenge": challenge, "signature": signature]
        ])
        guard result.ok, let grant = result.grant else {
            throw NSError(domain: "Jarvis", code: -3,
                          userInfo: [NSLocalizedDescriptionKey: "session_authorize_failed"])
        }
        grantToken = grant.grant_token
        grantExpiresAtMs = grant.expires_at_ms
        return grant.session_id
    }

    func post<T: Decodable>(_ path: String, body: [String: Any]) async throws -> T {
        var request = URLRequest(url: baseURL.appendingPathComponent(path))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        request.httpBody = try JSONSerialization.data(withJSONObject: body)
        let (data, response) = try await URLSession.shared.data(for: request)
        guard let http = response as? HTTPURLResponse, http.statusCode < 300 else {
            throw NSError(domain: "Jarvis", code: (response as? HTTPURLResponse)?.statusCode ?? -1,
                          userInfo: [NSLocalizedDescriptionKey: String(data: data, encoding: .utf8) ?? ""])
        }
        return try JSONDecoder().decode(T.self, from: data)
    }

    func dict(_ identity: JarvisIdentity) throws -> [String: Any] {
        let data = try JSONEncoder().encode(identity)
        return try JSONSerialization.jsonObject(with: data) as! [String: Any]
    }
}
