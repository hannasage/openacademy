import SwiftUI
import AVFoundation

enum HubCameraPermission {
    static func request(status: AVAuthorizationStatus = AVCaptureDevice.authorizationStatus(for: .video),
                        ask: @escaping () async -> Bool = { await AVCaptureDevice.requestAccess(for: .video) }) async -> Bool {
        switch status { case .authorized: return true; case .notDetermined: return await ask(); default: return false }
    }
}
struct HubScannerView: View {
    @Environment(\.dismiss) private var dismiss
    let completion: (Result<String, Error>) -> Void
    var body: some View {
        NavigationStack {
            VStack(spacing: 20) {
                Text("Point the camera at the hub code on your desktop.").padding()
                HubCameraPreview(completion: completion).accessibilityLabel("Hub QR code camera")
                Text("Scanning finds a hub. You will review its address before signing in.").font(.subheadline).padding()
            }.navigationTitle("Scan hub QR code").navigationBarTitleDisplayMode(.inline)
                .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } } }
        }
    }
}
private struct HubCameraPreview: UIViewRepresentable {
    let completion: (Result<String, Error>) -> Void
    func makeCoordinator() -> Coordinator { Coordinator(completion: completion) }
    func makeUIView(context: Context) -> CameraSurface {
        let view = CameraSurface()
        view.preview.session = context.coordinator.session; view.preview.videoGravity = .resizeAspectFill
        context.coordinator.start()
        return view
    }
    func updateUIView(_ view: CameraSurface, context: Context) {}
    static func dismantleUIView(_ view: CameraSurface, coordinator: Coordinator) { coordinator.stop() }
    final class CameraSurface: UIView {
        override class var layerClass: AnyClass { AVCaptureVideoPreviewLayer.self }
        var preview: AVCaptureVideoPreviewLayer { layer as! AVCaptureVideoPreviewLayer }
    }
    final class Coordinator: NSObject, AVCaptureMetadataOutputObjectsDelegate, @unchecked Sendable {
        let session = AVCaptureSession()
        private let queue = DispatchQueue(label: "touchline.hub-scanner")
        private var completed = false
        private var stopped = false
        let completion: (Result<String, Error>) -> Void
        init(completion: @escaping (Result<String, Error>) -> Void) { self.completion = completion }
        func start() {
            queue.async { [self] in
                guard !stopped else { return }
                do {
                    guard AVCaptureDevice.authorizationStatus(for: .video) == .authorized, let camera = AVCaptureDevice.default(for: .video) else { throw HubError.message("The camera is unavailable. Enter your hub address instead.") }
                    let input = try AVCaptureDeviceInput(device: camera), output = AVCaptureMetadataOutput()
                    guard session.canAddInput(input), session.canAddOutput(output) else { throw HubError.message("The camera could not start. Enter your hub address instead.") }
                    session.beginConfiguration(); session.addInput(input); session.addOutput(output)
                    output.setMetadataObjectsDelegate(self, queue: .main); output.metadataObjectTypes = [.qr]
                    session.commitConfiguration(); session.startRunning()
                } catch { DispatchQueue.main.async { self.finish(.failure(error)) } }
            }
        }
        func stop() { completed = true; queue.async { self.stopped = true; self.session.stopRunning() } }
        private func finish(_ result: Result<String, Error>) {
            guard !completed else { return }; completed = true; stop(); completion(result)
        }
        func metadataOutput(_ output: AVCaptureMetadataOutput, didOutput objects: [AVMetadataObject], from connection: AVCaptureConnection) {
            guard let text = objects.compactMap({ ($0 as? AVMetadataMachineReadableCodeObject)?.stringValue }).first else { return }
            do { _ = try HubLink.origin(text); finish(.success(text)) }
            catch { finish(.failure(error)) }
        }
    }
}
