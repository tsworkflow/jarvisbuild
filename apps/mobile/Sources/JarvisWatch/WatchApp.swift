import SwiftUI
import CryptoKit

// Tynn Watch-klient (VOICE_ARCHITECTURE/fase 8): varsler, korte svar og
// klasse D-godkjenning. Ingen Jarvis-hjerne/minne på klokken - alt bor i Core.
@main
struct JarvisWatchApp: App {
    var body: some Scene { WindowGroup { WatchHome() } }
}

/**
 D-131 (uavhengig arkitektkontroll av PR #79): flyttet ut av `WatchHome` fordi
 klienten MÅ være ÉN instans som lever på tvers av kall.

 `client` var en COMPUTED property på en SwiftUI-`View`-struct, så hvert kall
 fikk en fersk `JarvisClient` - og det server-utstedte beviset (tidligere
 `sessionId`, nå `grantToken`) ble kastet mellom `authorizeSession()` og
 `chat()`. Med et grant som faktisk må presenteres ved hvert kall er det
 forskjellen på at klokken virker og ikke virker.
 */
@MainActor
final class WatchModel: ObservableObject {
    @Published var status = "…"
    /// D-131 funn 2: engangs-billett fra en lokal eier-handling
    /// (`pnpm --filter @jarvis/api enroll-ticket`). Anonym innrullering finnes
    /// ikke lenger - klokken kan ikke lenger skrive sin egen nøkkel uten bevis.
    @Published var enrollmentTicket = ""
    @Published var enrolled = false
    @AppStorage("jarvis.server") var server = "http://192.168.1.10:3010"
    @AppStorage("jarvis.device") var deviceId = "watch-\(UUID().uuidString.prefix(8))"

    lazy var client: JarvisClient = JarvisClient(
        baseURL: URL(string: server)!,
        identity: JarvisIdentity(person: "person-tobias", tenant: "tenant-personal",
                                 device: deviceId, channel: "watch")
    )

    /// Autoriserer med den eksisterende innrulleringen hvis den finnes; ellers
    /// innrullerer med eier-billetten. `try?` brukes KUN på autorisasjons-
    /// forsøket (der «ikke innrullert ennå» er et forventet utfall) - aldri på
    /// selve innrulleringen, som skal feile synlig.
    func setup() async {
        guard let key = try? DeviceKeys.loadOrCreate() else {
            status = "Nøkkelfeil"
            return
        }
        if (try? await client.authorizeSession(key: key)) != nil {
            enrolled = true
            status = "Klar"
            return
        }
        let ticket = enrollmentTicket.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !ticket.isEmpty else {
            status = "Ikke innrullert - lim inn billett"
            return
        }
        do {
            try await client.enrollWithTicket(kind: "watch",
                                              publicKeyPem: DeviceKeys.publicKeyPem(key),
                                              ticket: ticket)
            enrollmentTicket = ""
            try await client.authorizeSession(key: key)
            enrolled = true
            status = "Klar"
        } catch { status = "Innrullering feilet: \(error.localizedDescription)" }
    }

    func quick(_ text: String) async {
        do { status = try await client.chat(text)?.reply ?? "(dedupe)" }
        catch { status = "Feil: \(error.localizedDescription)" }
    }

    func approve() async {
        do {
            let key = try DeviceKeys.loadOrCreate()
            let approval = try ApprovalSigner.sign(toolId: "demo", action: "critical_demo", parameters: ["confirm": "true"],
                                                   tenantId: "tenant-personal", personId: "person-tobias",
                                                   approverPersonId: "person-tobias",
                                                   deviceId: deviceId, validSeconds: 60, key: key)
            struct Decision: Codable { let decision: String }
            let result: Decision = try await client.post("tools/critical-demo", body: [
                 "grant_token": try await client.currentGrantToken(),
                "parameters": ["confirm": "true"],
                "approval": ["tool_id": approval.tool_id, "action": approval.action,
                             "parameters_hash": approval.parameters_hash, "tenant_id": approval.tenant_id,
                             "person_id": approval.person_id, "approver_person_id": approval.approver_person_id,
                             "approving_device_id": approval.approving_device_id,
                             "issued_at": approval.issued_at, "expires_at": approval.expires_at,
                             "nonce": approval.nonce, "signature": approval.signature]
            ])
            status = "Godkjenning: \(result.decision)"
        } catch { status = "Avvist: \(error.localizedDescription)" }
    }
}

struct WatchHome: View {
    @StateObject private var model = WatchModel()

    var body: some View {
        VStack(spacing: 8) {
            Text("Jarvis").font(.headline)
            Text(model.status).font(.footnote).lineLimit(4)
            if !model.enrolled {
                TextField("Billett", text: $model.enrollmentTicket)
                Button("Innrullér") { Task { await model.setup() } }
            }
            Button("Status") { Task { await model.quick("status") } }
            Button("Godkjenn (D)") { Task { await model.approve() } }
        }
        .task { await model.setup() }
    }
}
