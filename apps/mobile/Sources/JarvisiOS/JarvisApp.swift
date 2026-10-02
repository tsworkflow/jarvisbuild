import SwiftUI
import CryptoKit

@main
struct JarvisApp: App {
    var body: some Scene { WindowGroup { ChatView() } }
}

@MainActor
final class ChatModel: ObservableObject {
    @Published var messages: [(role: String, text: String)] = []
    @Published var sessionId = "-"
    @Published var deviceVerified = false
    /// D-131 funn 2: engangs-billett fra en lokal eier-handling
    /// (`pnpm --filter @jarvis/api enroll-ticket`). Kreves KUN første gang -
    /// anonym innrullering finnes ikke lenger.
    @Published var enrollmentTicket = ""
    @AppStorage("jarvis.server") var server = "http://192.168.1.10:3010"
    @AppStorage("jarvis.device") var deviceId = "iphone-\(UUID().uuidString.prefix(8))"

    /// D-131 funn 1: klienten MÅ være ÉN instans som lever. Den var tidligere en
    /// COMPUTED property, så hvert eneste kall fikk en fersk `JarvisClient` -
    /// og det server-utstedte beviset (tidligere `sessionId`, nå `grantToken`)
    /// ble kastet mellom `authorizeSession()` og `chat()`. Med et grant som
    /// faktisk må presenteres ved hvert kall, er det forskjellen på at
    /// klienten virker og ikke virker.
    lazy var client: JarvisClient = JarvisClient(
        baseURL: URL(string: server)!,
        identity: JarvisIdentity(person: "person-tobias", tenant: "tenant-personal",
                                 device: deviceId, channel: "mobile")
    )

    /// Autoriserer med den eksisterende innrulleringen hvis den finnes; ellers
    /// innrullerer den med en eier-billett. Ingen anonym innrullering, og ingen
    /// stille «prøvde å registrere, ignorerte feilen»-sti.
    func setupDevice() async {
        do {
            let key = try DeviceKeys.loadOrCreate()
            if (try? await client.authorizeSession(key: key)) != nil {
                deviceVerified = true
                return
            }
            let ticket = enrollmentTicket.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !ticket.isEmpty else {
                messages.append(("system",
                    "Enheten er ikke innrullert. Kjør `pnpm --filter @jarvis/api enroll-ticket` på Jarvis-maskinen og lim inn billetten."))
                return
            }
            try await client.enrollWithTicket(kind: "iphone",
                                              publicKeyPem: DeviceKeys.publicKeyPem(key),
                                              ticket: ticket)
            enrollmentTicket = ""
            try await client.authorizeSession(key: key)
            deviceVerified = true
        } catch { messages.append(("system", "Enhetsoppsett feilet: \(error.localizedDescription)")) }
    }

    func send(_ text: String) async {
        messages.append(("user", text))
        do {
            if let reply = try await client.chat(text) {
                sessionId = reply.session_id
                messages.append(("jarvis", reply.reply + "  · rute: \(reply.routed)"))
            }
        } catch { messages.append(("system", "Feil: \(error.localizedDescription)")) }
    }

    /// Klasse D-godkjenning: signeres lokalt med enhetsnøkkelen; serveren
    /// verifiserer signatur/handling/parametere/utløp/engangs-nonce.
    func approveCriticalDemo() async {
        do {
            let key = try DeviceKeys.loadOrCreate()
            let approval = try ApprovalSigner.sign(toolId: "demo", action: "critical_demo", parameters: ["confirm": "true"],
                                                   tenantId: "tenant-personal", personId: "person-tobias",
                                                   approverPersonId: "person-tobias",
                                                   deviceId: deviceId, validSeconds: 60, key: key)
            let body: [String: Any] = [
                 "grant_token": try await client.currentGrantToken(),
                "parameters": ["confirm": "true"],
                "approval": ["tool_id": approval.tool_id, "action": approval.action,
                             "parameters_hash": approval.parameters_hash, "tenant_id": approval.tenant_id,
                             "person_id": approval.person_id, "approver_person_id": approval.approver_person_id,
                             "approving_device_id": approval.approving_device_id,
                             "issued_at": approval.issued_at, "expires_at": approval.expires_at,
                             "nonce": approval.nonce, "signature": approval.signature]
            ]
            struct Decision: Codable { let decision: String }
            let result: Decision = try await client.post("tools/critical-demo", body: body)
            messages.append(("system", "Godkjenning: \(result.decision)"))
        } catch { messages.append(("system", "Godkjenning avvist: \(error.localizedDescription)")) }
    }
}

struct ChatView: View {
    @StateObject var model = ChatModel()
    @State var input = ""
    var body: some View {
        NavigationStack {
            List(model.messages.indices, id: \.self) { i in
                Text(model.messages[i].text)
                    .frame(maxWidth: .infinity, alignment: model.messages[i].role == "user" ? .trailing : .leading)
            }
            if !model.deviceVerified {
                // D-131 funn 2: synlig bootstrap-sti i stedet for en usynlig,
                // anonym innrullering som «bare virket».
                HStack {
                    TextField("Innrullerings-billett …", text: $model.enrollmentTicket)
                        .textFieldStyle(.roundedBorder)
                    Button("Innrullér") { Task { await model.setupDevice() } }
                }.padding(.horizontal)
            }
            HStack {
                TextField("Snakk med Jarvis …", text: $input).textFieldStyle(.roundedBorder)
                Button("Send") { let t = input; input = ""; Task { await model.send(t) } }
            }.padding()
            .navigationTitle("Jarvis \(model.deviceVerified ? "🔐" : "")")
            .toolbar {
                Button("Godkjenn demo (D)") { Task { await model.approveCriticalDemo() } }
            }
            .task { await model.setupDevice() }
        }
    }
}
