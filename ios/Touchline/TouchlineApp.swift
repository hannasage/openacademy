import SwiftUI

@main
struct TouchlineApp: App {
    @StateObject private var store = HubStore()
    var body: some Scene {
        WindowGroup { AppearanceRoot().environmentObject(store) }
    }
}
