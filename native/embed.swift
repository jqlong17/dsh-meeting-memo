// 逐文件算声纹：用于验证「片段级声纹 + 质心匹配」是否可行。
// 用法：embed <model.onnx> <a.wav> [b.wav ...]
import Foundation

func readWav(_ path: String) -> [Float]? {
    guard let data = try? Data(contentsOf: URL(fileURLWithPath: path)) else { return nil }
    guard data.count > 44, data.prefix(4) == Data("RIFF".utf8) else { return nil }
    var offset = 12
    while offset + 8 <= data.count {
        let id = String(bytes: data[offset..<(offset + 4)], encoding: .ascii) ?? ""
        let size = Int(data[(offset + 4)..<(offset + 8)].withUnsafeBytes { $0.load(as: UInt32.self) })
        if id == "data" {
            let start = offset + 8
            let end = min(data.count, start + size)
            let count = (end - start) / 2
            var samples = [Float](repeating: 0, count: count)
            data.subdata(in: start..<end).withUnsafeBytes { raw in
                let pointer = raw.bindMemory(to: Int16.self)
                for i in 0..<count { samples[i] = Float(pointer[i]) / 32768.0 }
            }
            return samples
        }
        offset += 8 + size + (size % 2)
    }
    return nil
}

func embedMain() {
    let args = CommandLine.arguments
    guard args.count >= 3 else {
        FileHandle.standardError.write("usage: embed <model.onnx> <a.wav> [b.wav ...]\n".data(using: .utf8)!)
        exit(2)
    }
    let model = strdup(args[1])
    var config = SherpaOnnxSpeakerEmbeddingExtractorConfig()
    config.model = UnsafePointer(model)
    config.num_threads = 1
    config.debug = 0
    config.provider = UnsafePointer(strdup("cpu"))
    guard let extractor = SherpaOnnxCreateSpeakerEmbeddingExtractor(&config) else {
        FileHandle.standardError.write("无法加载声纹模型\n".data(using: .utf8)!)
        exit(1)
    }
    defer { SherpaOnnxDestroySpeakerEmbeddingExtractor(extractor) }
    let dim = Int(SherpaOnnxSpeakerEmbeddingExtractorDim(extractor))

    for path in args.dropFirst(2) {
        guard let samples = readWav(path), !samples.isEmpty else { continue }
        guard let stream = SherpaOnnxSpeakerEmbeddingExtractorCreateStream(extractor) else { continue }
        defer { SherpaOnnxDestroyOnlineStream(stream) }
        samples.withUnsafeBufferPointer { buffer in
            SherpaOnnxOnlineStreamAcceptWaveform(stream, 16000, buffer.baseAddress, Int32(buffer.count))
        }
        SherpaOnnxOnlineStreamInputFinished(stream)
        guard SherpaOnnxSpeakerEmbeddingExtractorIsReady(extractor, stream) != 0 else { continue }
        guard let vector = SherpaOnnxSpeakerEmbeddingExtractorComputeEmbedding(extractor, stream) else { continue }
        var values: [Float] = []
        values.reserveCapacity(dim)
        for i in 0..<dim { values.append(vector[i]) }
        let payload: [String: Any] = ["path": path, "frames": samples.count, "dim": dim, "vector": values]
        if let data = try? JSONSerialization.data(withJSONObject: payload),
           let line = String(data: data, encoding: .utf8) {
            print(line)
        }
    }
}

embedMain()
