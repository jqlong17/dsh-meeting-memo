import AVFoundation
import CoreAudio
import CoreML
import Foundation
#if canImport(AppKit)
import AppKit
import UniformTypeIdentifiers
#endif
#if canImport(ScreenCaptureKit)
import ScreenCaptureKit
import CoreMedia
#endif

/// Mic + optional system-audio capture, energy VAD, SenseVoice Core ML int8.
/// Stdout is one JSON object per line. Node owns the life-log files.

let sampleRate = 16_000
let minSamples = 3_200
/// notta LifeLog mic gate: 0.015 RMS, 900 ms silence latch, 450 ms minimum.
let vadThreshold = Float(0.015)
let silenceSeconds = 0.9
let minSpeechSeconds = 0.45
let maxSamples = 480_000 // 30s safety cap; notta's observed sentences run past its 12s source default
let prerollSeconds = 0.3
let vadChunk = 160 // 10 ms, same chunk size as notta's scheduler

func emit(_ object: [String: Any]) {
    guard let data = try? JSONSerialization.data(withJSONObject: object),
          let line = String(data: data, encoding: .utf8) else { return }
    print(line)
    fflush(stdout)
}

func arg(_ name: String) -> String? {
    let flag = "--\(name)"
    guard let index = CommandLine.arguments.firstIndex(of: flag), index + 1 < CommandLine.arguments.count else { return nil }
    return CommandLine.arguments[index + 1]
}

final class SenseVoice {
    private var preprocessor: MLModel?
    private var encoder: MLModel?
    private var vocabulary: [String] = []
    private let buckets = [128, 256, 512, 1024, 1800]
    private let featureDim = 560

    func load(dir: String) throws {
        let enc = URL(fileURLWithPath: dir).appendingPathComponent("SenseVoiceSmall_int8.mlmodelc")
        let prep = URL(fileURLWithPath: dir).appendingPathComponent("SenseVoicePreprocessor.mlmodelc")
        let vocab = URL(fileURLWithPath: dir).appendingPathComponent("vocab.json")
        let prepConfig = MLModelConfiguration()
        prepConfig.computeUnits = .cpuOnly
        let encConfig = MLModelConfiguration()
        encConfig.computeUnits = .cpuOnly
        preprocessor = try MLModel(contentsOf: prep, configuration: prepConfig)
        encoder = try MLModel(contentsOf: enc, configuration: encConfig)
        let data = try Data(contentsOf: vocab)
        vocabulary = try JSONDecoder().decode([String].self, from: data)
    }

    func transcribe(_ samples: [Float], languageId: Int32 = 0) throws -> String {
        guard let preprocessor, let encoder else { return "" }
        let audio = Array(samples.prefix(480_000))
        guard audio.count >= minSamples else { return "" }
        let waveform = try MLMultiArray(shape: [1, NSNumber(value: audio.count)], dataType: .float32)
        let ptr = waveform.dataPointer.assumingMemoryBound(to: Float.self)
        for i in 0..<audio.count { ptr[i] = audio[i] * 32_768 }
        let prepOut = try preprocessor.prediction(from: try MLDictionaryFeatureProvider(dictionary: [
            "waveform": MLFeatureValue(multiArray: waveform),
        ]))
        guard let features = prepOut.featureValue(for: "features")?.multiArrayValue else { return "" }
        var frames = features.shape[1].intValue
        if frames > (buckets.last ?? 1800) { frames = buckets.last ?? 1800 }
        let bucket = buckets.first(where: { $0 >= frames }) ?? (buckets.last ?? 1800)
        let speech = try MLMultiArray(shape: [1, NSNumber(value: bucket), NSNumber(value: featureDim)], dataType: .float32)
        let sptr = speech.dataPointer.assumingMemoryBound(to: Float.self)
        memset(sptr, 0, bucket * featureDim * MemoryLayout<Float>.size)
        let count = min(frames * featureDim, features.count)
        if features.dataType == .float32 {
            memcpy(sptr, features.dataPointer, count * MemoryLayout<Float>.size)
        } else {
            for i in 0..<count { sptr[i] = features[i].floatValue }
        }
        let lengths = try MLMultiArray(shape: [1], dataType: .int32)
        lengths[0] = NSNumber(value: Int32(frames))
        let language = try MLMultiArray(shape: [1], dataType: .int32)
        language[0] = NSNumber(value: languageId)
        let textnorm = try MLMultiArray(shape: [1], dataType: .int32)
        textnorm[0] = 14
        let encOut = try encoder.prediction(from: try MLDictionaryFeatureProvider(dictionary: [
            "speech": MLFeatureValue(multiArray: speech),
            "speech_lengths": MLFeatureValue(multiArray: lengths),
            "language": MLFeatureValue(multiArray: language),
            "textnorm": MLFeatureValue(multiArray: textnorm),
        ]))
        guard let logits = encOut.featureValue(for: "ctc_logits")?.multiArrayValue else { return "" }
        return decode(logits, validFrames: frames + 4)
    }

    func transcribePreferred(_ samples: [Float], preference: String) throws -> String {
        if preference == "en" { return try transcribe(samples, languageId: 4) }
        if preference == "zh" { return try transcribe(samples, languageId: 3) }
        let auto = try transcribe(samples, languageId: 0)
        if preference != "zhen" || !Self.kanaHeavy(auto) { return auto }
        let zh = try transcribe(samples, languageId: 3)
        return zh.isEmpty ? auto : zh
    }

    /// Auto LID often writes Chinese as hiragana. Retry those with zh.
    static func kanaHeavy(_ text: String) -> Bool {
        var kana = 0
        var han = 0
        for scalar in text.unicodeScalars {
            let value = scalar.value
            if (0x3040...0x30FF).contains(value) { kana += 1 }
            else if (0x4E00...0x9FFF).contains(value) { han += 1 }
        }
        return kana >= 2 && kana > han
    }

    private func decode(_ logits: MLMultiArray, validFrames: Int) -> String {
        let frames = min(validFrames, logits.shape[1].intValue)
        let vocabSize = logits.shape[2].intValue
        var ids: [Int] = []
        var prev = -1
        for f in 0..<frames {
            var best = 0
            var bestVal = -Float.greatestFiniteMagnitude
            for v in 0..<vocabSize {
                let val = logits[[0, f, v] as [NSNumber]].floatValue
                if val > bestVal { bestVal = val; best = v }
            }
            if best != 0 && best != prev { ids.append(best) }
            prev = best
        }
        var text = ids.compactMap { id -> String? in
            guard id >= 0, id < vocabulary.count else { return nil }
            return vocabulary[id]
        }.joined()
        text = text.replacingOccurrences(of: "▁", with: " ")
        if let regex = try? NSRegularExpression(pattern: "<\\|[^|]*\\|>") {
            text = regex.stringByReplacingMatches(in: text, range: NSRange(location: 0, length: (text as NSString).length), withTemplate: "")
        }
        return text.trimmingCharacters(in: .whitespacesAndNewlines)
    }
}

final class Utterance {
    var samples: [Float] = []
    var preroll: [Float] = []
    var pending: [Float] = []
    var startedAt = Date()
    var speechSeconds = 0.0
    var silenceRun = 0
    var open = false
    let prerollMax = Int(prerollSeconds * Double(sampleRate))
    let releaseChunks = max(1, Int(silenceSeconds / 0.01))
    /// 换人检测：每 1.6 秒取一次窗口声纹，和本句开头的锚点比。
    var windowVector: (([Float]) -> [Float]?)?
    var splitter = SpeakerSplitter()
    let checkEvery = Int(1.6 * Double(sampleRate))
    let windowSamples = Int(1.6 * Double(sampleRate))
    let splitOverlap = Int(0.2 * Double(sampleRate))
    let minSplitSamples = Int(2.5 * Double(sampleRate))
    var lastCheck = 0
    /// 这一段是不是「换人切开」切出来的前半截（用于在转写里留痕）。
    var lastSplit = false

    func push(_ frame: [Float], now: Date) -> (flush: [Float], start: Date, speech: Double)? {
        pending.append(contentsOf: frame)
        var flushed: (flush: [Float], start: Date, speech: Double)?
        while pending.count >= vadChunk {
            let chunk = Array(pending.prefix(vadChunk))
            pending.removeFirst(vadChunk)
            if let done = consume(chunk, now: now) {
                flushed = done
            }
        }
        return flushed
    }

    private func consume(_ chunk: [Float], now: Date) -> (flush: [Float], start: Date, speech: Double)? {
        let rms = sqrt(chunk.reduce(0) { $0 + $1 * $1 } / Float(chunk.count))
        if rms >= vadThreshold {
            silenceRun = 0
            if !open {
                open = true
                samples = preroll + chunk
                preroll = []
                startedAt = now.addingTimeInterval(-Double(samples.count) / Double(sampleRate))
                speechSeconds = Double(chunk.count) / Double(sampleRate)
                return nil
            }
            samples.append(contentsOf: chunk)
            speechSeconds += Double(chunk.count) / Double(sampleRate)
            if samples.count >= maxSamples {
                return close()
            }
            // 两个人的声音被判成一句：按声纹在中间切开，各算各的
            if windowVector != nil, samples.count - lastCheck >= checkEvery, samples.count >= minSplitSamples {
                lastCheck = samples.count
                let from = samples.count - windowSamples
                if from > 0, let vec = windowVector?(Array(samples[from..<samples.count])),
                   splitter.observe(vec) {
                    let cut = max(minSamples, min(samples.count - 1, from + splitOverlap))
                    let first = Array(samples[0..<cut])
                    let firstStart = startedAt
                    let firstSpeech = speechSeconds * Double(cut) / Double(samples.count)
                    let rest = Array(samples[cut..<samples.count])
                    samples = rest
                    startedAt = now.addingTimeInterval(-Double(rest.count) / Double(sampleRate))
                    speechSeconds = Double(rest.count) / Double(sampleRate)
                    silenceRun = 0
                    lastCheck = rest.count
                    splitter.reset()
                    lastSplit = true
                    return (first, firstStart, firstSpeech)
                }
            }
            return nil
        }
        if !open {
            preroll.append(contentsOf: chunk)
            if preroll.count > prerollMax {
                preroll.removeFirst(preroll.count - prerollMax)
            }
            return nil
        }
        samples.append(contentsOf: chunk)
        silenceRun += 1
        if silenceRun >= releaseChunks || samples.count >= maxSamples {
            return close()
        }
        return nil
    }

    private func close() -> (flush: [Float], start: Date, speech: Double)? {
        let done = samples
        let start = startedAt
        let speech = speechSeconds
        reset()
        guard speech >= minSpeechSeconds, done.count >= minSamples else { return nil }
        return (done, start, speech)
    }

    func flush() -> (flush: [Float], start: Date, speech: Double)? {
        guard open, samples.count >= minSamples else { reset(); return nil }
        let done = samples
        let start = startedAt
        let speech = speechSeconds
        reset()
        return (done, start, speech)
    }

    private func reset() {
        splitter.reset()
        lastSplit = false
        lastCheck = 0
        samples = []
        preroll = []
        pending = []
        open = false
        silenceRun = 0
        speechSeconds = 0
    }
}

func writeWav(_ samples: [Float], to url: URL) throws {
    let dir = url.deletingLastPathComponent()
    try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    var data = Data()
    func u32(_ value: UInt32) { var v = value.littleEndian; data.append(Data(bytes: &v, count: 4)) }
    func u16(_ value: UInt16) { var v = value.littleEndian; data.append(Data(bytes: &v, count: 2)) }
    let pcm = samples.map { Int16(max(-1, min(1, $0)) * 32_767) }
    var body = Data()
    pcm.withUnsafeBytes { body.append(contentsOf: $0) }
    data.append(contentsOf: "RIFF".utf8)
    u32(UInt32(36 + body.count))
    data.append(contentsOf: "WAVE".utf8)
    data.append(contentsOf: "fmt ".utf8)
    u32(16); u16(1); u16(1); u32(UInt32(sampleRate)); u32(UInt32(sampleRate * 2)); u16(2); u16(16)
    data.append(contentsOf: "data".utf8)
    u32(UInt32(body.count))
    data.append(body)
    try data.write(to: url)
}


// MARK: - 输入设备

struct InputDevice {
    let id: AudioDeviceID
    let uid: String
    let name: String
}

func propertyAddress(_ selector: AudioObjectPropertySelector, _ scope: AudioObjectPropertyScope = kAudioObjectPropertyScopeGlobal) -> AudioObjectPropertyAddress {
    AudioObjectPropertyAddress(mSelector: selector, mScope: scope, mElement: kAudioObjectPropertyElementMain)
}

func deviceString(_ device: AudioDeviceID, _ selector: AudioObjectPropertySelector) -> String {
    var address = propertyAddress(selector)
    var value: CFString = "" as CFString
    var size = UInt32(MemoryLayout<CFString>.size)
    let status = withUnsafeMutablePointer(to: &value) { pointer in
        AudioObjectGetPropertyData(device, &address, 0, nil, &size, pointer)
    }
    return status == noErr ? value as String : ""
}

func hasInput(_ device: AudioDeviceID) -> Bool {
    var address = propertyAddress(kAudioDevicePropertyStreamConfiguration, kAudioObjectPropertyScopeInput)
    var size: UInt32 = 0
    guard AudioObjectGetPropertyDataSize(device, &address, 0, nil, &size) == noErr, size > 0 else { return false }
    let raw = UnsafeMutableRawPointer.allocate(byteCount: Int(size), alignment: MemoryLayout<AudioBufferList>.alignment)
    defer { raw.deallocate() }
    guard AudioObjectGetPropertyData(device, &address, 0, nil, &size, raw) == noErr else { return false }
    let list = UnsafeMutableAudioBufferListPointer(raw.assumingMemoryBound(to: AudioBufferList.self))
    return list.contains { $0.mNumberChannels > 0 }
}

func inputDevices() -> [InputDevice] {
    var address = propertyAddress(kAudioHardwarePropertyDevices)
    var size: UInt32 = 0
    guard AudioObjectGetPropertyDataSize(AudioObjectID(kAudioObjectSystemObject), &address, 0, nil, &size) == noErr else { return [] }
    var ids = [AudioDeviceID](repeating: 0, count: Int(size) / MemoryLayout<AudioDeviceID>.size)
    guard AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &address, 0, nil, &size, &ids) == noErr else { return [] }
    return ids.filter { hasInput($0) }.map { id in
        InputDevice(id: id, uid: deviceString(id, kAudioDevicePropertyDeviceUID), name: deviceString(id, kAudioObjectPropertyName))
    }
}

func defaultInputID() -> AudioDeviceID? {
    var address = propertyAddress(kAudioHardwarePropertyDefaultInputDevice)
    var device = AudioDeviceID(0)
    var size = UInt32(MemoryLayout<AudioDeviceID>.size)
    guard AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &address, 0, nil, &size, &device) == noErr else { return nil }
    return device == 0 ? nil : device
}


// MARK: - 声纹

/// CAM++ 之类的声纹模型：把一段音频压成定长向量。
final class SpeakerEmbedder {
    private var extractor: OpaquePointer?
    private(set) var dim = 0

    init?(model: String) {
        var config = SherpaOnnxSpeakerEmbeddingExtractorConfig()
        config.model = UnsafePointer(strdup(model))
        config.num_threads = 1
        config.debug = 0
        config.provider = UnsafePointer(strdup("cpu"))
        guard let created = SherpaOnnxCreateSpeakerEmbeddingExtractor(&config) else { return nil }
        extractor = created
        dim = Int(SherpaOnnxSpeakerEmbeddingExtractorDim(created))
        if dim <= 0 { SherpaOnnxDestroySpeakerEmbeddingExtractor(created); extractor = nil; return nil }
    }

    deinit {
        if let extractor { SherpaOnnxDestroySpeakerEmbeddingExtractor(extractor) }
    }

    /// 原始向量，供内部的「换人检测」用，不走 base64。
    func vector(_ samples: [Float]) -> [Float]? {
        guard let extractor, !samples.isEmpty else { return nil }
        guard let stream = SherpaOnnxSpeakerEmbeddingExtractorCreateStream(extractor) else { return nil }
        defer { SherpaOnnxDestroyOnlineStream(stream) }
        samples.withUnsafeBufferPointer { buffer in
            SherpaOnnxOnlineStreamAcceptWaveform(stream, Int32(sampleRate), buffer.baseAddress, Int32(buffer.count))
        }
        SherpaOnnxOnlineStreamInputFinished(stream)
        guard SherpaOnnxSpeakerEmbeddingExtractorIsReady(extractor, stream) != 0 else { return nil }
        guard let raw = SherpaOnnxSpeakerEmbeddingExtractorComputeEmbedding(extractor, stream) else { return nil }
        defer { SherpaOnnxSpeakerEmbeddingExtractorDestroyEmbedding(raw) }
        var out = [Float](repeating: 0, count: dim)
        for i in 0..<dim { out[i] = raw[i] }
        return out
    }

    /// float16 + base64：192 维只占 512 字节，JSON 不会膨胀。
    func embedding(_ samples: [Float]) -> String? {
        guard let extractor, !samples.isEmpty else { return nil }
        guard let stream = SherpaOnnxSpeakerEmbeddingExtractorCreateStream(extractor) else { return nil }
        defer { SherpaOnnxDestroyOnlineStream(stream) }
        samples.withUnsafeBufferPointer { buffer in
            SherpaOnnxOnlineStreamAcceptWaveform(stream, Int32(sampleRate), buffer.baseAddress, Int32(buffer.count))
        }
        SherpaOnnxOnlineStreamInputFinished(stream)
        guard SherpaOnnxSpeakerEmbeddingExtractorIsReady(extractor, stream) != 0 else { return nil }
        guard let vector = SherpaOnnxSpeakerEmbeddingExtractorComputeEmbedding(extractor, stream) else { return nil }
        var bytes: [UInt8] = []
        bytes.reserveCapacity(dim * 2)
        for i in 0..<dim {
            let bits = floatToHalf(vector[i])
            bytes.append(UInt8(bits & 0xFF))
            bytes.append(UInt8((bits >> 8) & 0xFF))
        }
        return Data(bytes).base64EncodedString()
    }
}

/// Float32 → Float16 的位转换（只需要存，不需要还原精度）。
func floatToHalf(_ value: Float) -> UInt16 {
    let bits = value.bitPattern
    let sign = UInt16((bits >> 16) & 0x8000)
    var exponent = Int((bits >> 23) & 0xFF) - 127 + 15
    var mantissa = (bits & 0x7FFFFF) >> 13
    if exponent <= 0 { return sign }
    if exponent >= 31 { return sign | 0x7C00 }
    mantissa = (bits >> 13) & 0x3FF
    return sign | UInt16(exponent << 10) | UInt16(mantissa)
}

func downsample(_ buffer: AVAudioPCMBuffer, converter: AVAudioConverter, target: AVAudioFormat) -> [Float] {
    let ratio = target.sampleRate / buffer.format.sampleRate
    let capacity = AVAudioFrameCount(Double(buffer.frameLength) * ratio) + 32
    guard let out = AVAudioPCMBuffer(pcmFormat: target, frameCapacity: capacity) else { return [] }
    var error: NSError?
    var consumed = false
    converter.convert(to: out, error: &error) { _, status in
        if consumed {
            status.pointee = .noDataNow
            return nil
        }
        consumed = true
        status.pointee = .haveData
        return buffer
    }
    if error != nil || out.frameLength == 0 { return [] }
    guard let channel = out.floatChannelData?[0] else { return [] }
    return Array(UnsafeBufferPointer(start: channel, count: Int(out.frameLength)))
}

/**
 * 离线转写：读一个音频文件，复用同一套 VAD 与 SenseVoice，输出相对时间。
 *
 * 和实时采集的区别：时间基准是文件内的秒数（epoch + 偏移），不是墙上时钟；
 * 单轨、不做换人切分；边读边发 progress，进程被杀即取消。
 */

#if canImport(AppKit)
/// 弹系统文件选择框，把绝对路径吐给插件。
/// 浏览器里的 <input type=file> 只给 File 对象、拿不到真实路径，所以选择必须发生在宿主侧。
func runPick() -> Never {
    let app = NSApplication.shared
    app.setActivationPolicy(.accessory)
    app.activate(ignoringOtherApps: true)
    let panel = NSOpenPanel()
    panel.allowsMultipleSelection = true
    panel.canChooseFiles = true
    panel.canChooseDirectories = false
    panel.title = "选择音频或视频"
    panel.message = "可以一次选多个；视频会自动抽取音轨"
    panel.prompt = "导入"
    if #available(macOS 11.0, *) {
        panel.allowedContentTypes = [.audio, .movie, .mpeg4Movie, .quickTimeMovie]
    }
    let response = panel.runModal()
    let paths = response == .OK ? panel.urls.map { $0.path } : []
    emit(["type": "picked", "paths": paths])
    exit(0)
}
#endif


/// 视频/奇怪容器：用 AVFoundation 抽出音轨到临时 m4a。失败返回 nil。
func exportAudioTrack(from url: URL) -> URL? {
    let asset = AVURLAsset(url: url)
    let audioTracks = asset.tracks(withMediaType: .audio)
    guard !audioTracks.isEmpty else { return nil }
    guard let session = AVAssetExportSession(asset: asset, presetName: AVAssetExportPresetAppleM4A) else { return nil }
    let out = URL(fileURLWithPath: NSTemporaryDirectory())
        .appendingPathComponent("asr-import-\(UUID().uuidString).m4a")
    session.outputURL = out
    session.outputFileType = .m4a
    let semaphore = DispatchSemaphore(value: 0)
    session.exportAsynchronously { semaphore.signal() }
    semaphore.wait()
    if session.status == .completed { return out }
    return nil
}

func runTranscribeFile(path: String, modelDir: String, language: String) -> Never {
    let model = SenseVoice()
    do {
        try model.load(dir: modelDir)
    } catch {
        emit(["type": "error", "message": "模型加载失败：\(error.localizedDescription)"])
        exit(1)
    }
    let sourceURL = URL(fileURLWithPath: path)
    var temporary: URL?
    var file: AVAudioFile?
    if let direct = try? AVAudioFile(forReading: sourceURL) {
        file = direct
    } else if let audio = exportAudioTrack(from: sourceURL), let converted = try? AVAudioFile(forReading: audio) {
        // 视频或容器：先用 AVFoundation 抽出音轨
        emit(["type": "info", "message": "已从视频中抽取音轨"])
        temporary = audio
        file = converted
    }
    guard let file else {
        emit(["type": "error", "message": "这个文件里没有可用的音轨：\(path)"])
        exit(1)
    }
    defer { if let temporary { try? FileManager.default.removeItem(at: temporary) } }
    let inputFormat = file.processingFormat
    guard inputFormat.sampleRate > 0,
          let target = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: Double(sampleRate), channels: 1, interleaved: false),
          let converter = AVAudioConverter(from: inputFormat, to: target) else {
        emit(["type": "error", "message": "这个音频的格式不支持转写"])
        exit(1)
    }
    let durationSec = Double(file.length) / inputFormat.sampleRate
    emit(["type": "start", "durationSec": durationSec, "sampleRate": inputFormat.sampleRate])

    let epoch = Date(timeIntervalSince1970: 0)
    let utterance = Utterance()
    var consumed = 0
    var snippets = 0
    var lastProgress = Date.distantPast
    let chunkFrames = AVAudioFrameCount(max(1024, Int(inputFormat.sampleRate)))

    func flush(_ done: (flush: [Float], start: Date, speech: Double)) {
        guard done.flush.count >= minSamples else { return }
        do {
            let text = try model.transcribePreferred(done.flush, preference: language)
            guard !text.isEmpty else { return }
            let startSec = done.start.timeIntervalSince(epoch)
            snippets += 1
            emit([
                "type": "snippet",
                "startSec": (startSec * 1000).rounded() / 1000,
                "endSec": ((startSec + Double(done.flush.count) / Double(sampleRate)) * 1000).rounded() / 1000,
                "text": text,
                "speechSeconds": done.speech,
            ])
        } catch {
            emit(["type": "error", "message": "转写失败：\(error.localizedDescription)"])
        }
    }

    while true {
        // 读到文件尾就停（AVAudioFile 在 EOF 会抛 -39，别当错误报出来）
        if file.framePosition >= file.length { break }
        guard let buffer = AVAudioPCMBuffer(pcmFormat: inputFormat, frameCapacity: chunkFrames) else { break }
        do {
            try file.read(into: buffer)
        } catch {
            emit(["type": "error", "message": "读取音频出错：\(error.localizedDescription)"])
            exit(1)
        }
        if buffer.frameLength == 0 { break }
        let mono = downsample(buffer, converter: converter, target: target)
        var index = 0
        while index < mono.count {
            let end = min(index + 320, mono.count)
            let frame = Array(mono[index..<end])
            index = end
            consumed += frame.count
            let now = epoch.addingTimeInterval(Double(consumed) / Double(sampleRate))
            if let done = utterance.push(frame, now: now) { flush(done) }
        }
        if Date().timeIntervalSince(lastProgress) > 2 {
            lastProgress = Date()
            emit([
                "type": "progress",
                "processedSec": min(durationSec, Double(consumed) / Double(sampleRate)),
                "durationSec": durationSec,
            ])
        }
    }
    if let done = utterance.flush() { flush(done) }
    emit(["type": "done", "snippets": snippets, "durationSec": durationSec])
    exit(0)
}

final class Capture: NSObject, SCStreamOutput, SCStreamDelegate {
    let model: SenseVoice?
    let mode: String
    let language: String
    let audioRoot: String?
    let queue = DispatchQueue(label: "asr-helper.audio")
    let mic = Utterance()
    let system = Utterance()
    var micSpeech = 0.0
    var systemSpeech = 0.0
    var micChars = 0
    var systemChars = 0
    var snippets = 0
    var micBuffers = 0
    var systemBuffers = 0
    var micPeak: Float = 0
    var systemPeak: Float = 0
    var minuteStart = Date()
    var engine: AVAudioEngine?
    /// 睡眠检测：墙上时钟与单调时钟的漂移（macOS 睡眠时单调时钟会停）。
    var lastTickWall = Date()
    var lastTickMono = clock_gettime_nsec_np(CLOCK_UPTIME_RAW)
    var sleepWatch: DispatchSourceTimer?
    var converter: AVAudioConverter?
    var stream: SCStream?
    let target = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: Double(sampleRate), channels: 1, interleaved: false)!
    /// 指定输入设备（UID）；为空则跟随系统默认。
    let inputUID: String?
    let embedder: SpeakerEmbedder?
    private(set) var inputName = ""
    /// 当前实际在用的输入设备 id：用来发现「耳机被拔了 / 默认设备换了」
    var currentInputID: AudioDeviceID = 0
    var deviceWatch: DispatchSourceTimer?
    /// 最后一次收到麦克风样本的时间：引擎「看着在跑但一个样本都没有」时用来判定假死
    var lastMicBufferAt = Date()

    init(model: SenseVoice?, mode: String, language: String, audioRoot: String?, inputUID: String?, embedModel: String?) {
        self.embedder = embedModel.flatMap { SpeakerEmbedder(model: $0) }
        self.model = model
        self.mode = mode
        self.language = language
        self.audioRoot = audioRoot
        self.inputUID = inputUID
        super.init()
    }

    /// 有语音模型时默认开启「换人切分」；--no-split-speaker 可关。
    func enableSpeakerSplit(threshold: Float) {
        guard let embedder else { return }
        let splitter = { (window: [Float]) -> [Float]? in embedder.vector(window) }
        mic.windowVector = splitter
        system.windowVector = splitter
        mic.splitter = SpeakerSplitter(threshold: threshold)
        system.splitter = SpeakerSplitter(threshold: threshold)
    }

    func start() {
        startMic()
        startSystem()
        watchSleep()
        watchDevices()
        minuteStart = Date()
        emit(["type": "status", "phase": "running", "mic": engine != nil, "system": stream != nil, "input": inputName])
    }

    /**
     * 睡眠检测：macOS 睡眠时 CLOCK_UPTIME_RAW 停走、墙上时钟继续。
     * 两者漂移超过 5 秒就说明刚睡醒 —— 此时音频引擎和 SCK 流多半已经死了，
     * 主动重建，而不是等用户说话发现没反应。
     */
    func watchSleep() {
        let timer = DispatchSource.makeTimerSource(queue: queue)
        timer.schedule(deadline: .now() + 3, repeating: 3)
        timer.setEventHandler { [weak self] in
            guard let self else { return }
            let now = Date()
            let mono = clock_gettime_nsec_np(CLOCK_UPTIME_RAW)
            let wall = now.timeIntervalSince(self.lastTickWall)
            let steady = Double(mono - self.lastTickMono) / 1_000_000_000
            self.lastTickWall = now
            self.lastTickMono = mono
            let slept = wall - steady
            guard slept > 5 else { return }
            emit(["type": "wake", "sleptSeconds": Int(slept)])
            self.restartCapture(reason: "睡醒后重建")
        }
        timer.resume()
        sleepWatch = timer
    }

    /**
     * 设备监视：耳机拔掉/插上、系统默认输入变了，都要立刻跟上。
     * 否则面板会一直显示已经不存在的设备名，采集仍在用旧设备。
     */
    func watchDevices() {
        let timer = DispatchSource.makeTimerSource(queue: queue)
        timer.schedule(deadline: .now() + 5, repeating: 5)
        timer.setEventHandler { [weak self] in
            guard let self else { return }
            // 引擎根本没起来（上次启动失败、设备被占用）：直接再试，别一直停在「未开启」
            if self.engine == nil {
                self.startMic()
                emit(["type": "status", "phase": "running", "mic": self.engine != nil, "system": self.stream != nil, "input": self.inputName])
                return
            }
            // 系统音流没起来也补一次（受权限/显示器状态影响）
            if self.stream == nil {
                self.startSystem()
                emit(["type": "status", "phase": "running", "mic": self.engine != nil, "system": self.stream != nil, "input": self.inputName])
                return
            }
            // 引擎在跑却 10 秒没有任何样本：多半是拔插耳机或设备切换后触点停了
            if Date().timeIntervalSince(self.lastMicBufferAt) > 10 {
                emit(["type": "warn", "track": "mic", "message": "麦克风没有样本回流，正在重建采集"])
                self.restartMic()
                self.lastMicBufferAt = Date()
                return
            }
            let devices = inputDevices()
            let wanted = self.inputUID.flatMap { uid in devices.first { $0.uid == uid }?.id } ?? defaultInputID() ?? 0
            guard wanted != self.currentInputID else { return }
            let name = devices.first { $0.id == wanted }?.name ?? ""
            emit([
                "type": "warn",
                "track": "mic",
                "message": "麦克风已切换为「\(name.isEmpty ? "系统默认" : name)」",
                "using": name,
            ])
            self.restartMic()
        }
        timer.resume()
        deviceWatch = timer
    }

    /// 只重建麦克风（系统音流不受输入设备影响）。
    func restartMic() {
        engine?.inputNode.removeTap(onBus: 0)
        engine?.stop()
        engine = nil
        startMic()
        emit(["type": "status", "phase": "running", "mic": engine != nil, "system": stream != nil, "input": inputName])
    }

    /// 重建音频引擎与系统音流（睡眠/切设备/权限变化之后）。
    func restartCapture(reason: String) {
        engine?.inputNode.removeTap(onBus: 0)
        engine?.stop()
        engine = nil
        if let stream {
            Task { try? await stream.stopCapture() }
            self.stream = nil
        }
        inputName = ""
        startMic()
        startSystem()
        _ = reason
    }

    func startMic() {
        let engine = AVAudioEngine()
        let input = engine.inputNode
        // 先把输入设备切到指定的那个（耳机麦 / 内置麦），再读格式。
        let devices = inputDevices()
        var chosen = inputUID.flatMap { uid in devices.first { $0.uid == uid } }
        // 钉住的设备被拔掉了：回退系统默认，并让插件知道（否则表现是「全绿但录不到」）
        if chosen == nil, let pinned = inputUID, !pinned.isEmpty {
            let fallback = devices.first { $0.id == (defaultInputID() ?? 0) }
            emit([
                "type": "warn",
                "track": "mic",
                "message": "指定的麦克风已断开，已临时改用「\(fallback?.name ?? "系统默认")」",
                "fallback": true,
                "lostUID": pinned,
                "using": fallback?.name ?? "",
            ])
            chosen = fallback
        }
        if let chosen, let unit = input.audioUnit {
            var device = chosen.id
            let status = AudioUnitSetProperty(unit, kAudioOutputUnitProperty_CurrentDevice,
                                              kAudioUnitScope_Global, 0, &device,
                                              UInt32(MemoryLayout<AudioDeviceID>.size))
            if status != noErr {
                emit(["type": "error", "track": "mic", "message": "切换输入设备失败：\(chosen.name)"])
            }
        }
        let actualID = chosen?.id ?? defaultInputID() ?? 0
        inputName = devices.first { $0.id == actualID }?.name ?? ""
        currentInputID = actualID
        // 输入节点要用 inputFormat：outputFormat 是硬件处理后的渲染格式，
        // 两者在 USB 麦克风上可能不一致（48k 双声道 vs 44.1k），拿错会把样本算坏。
        let format = input.inputFormat(forBus: 0)
        guard format.sampleRate > 0, format.channelCount > 0 else {
            emit(["type": "error", "track": "mic", "message": "没有可用的麦克风输入"])
            return
        }
        guard let converter = AVAudioConverter(from: format, to: target) else {
            emit(["type": "error", "track": "mic", "message": "无法把麦克风转到 16 kHz"])
            return
        }
        self.converter = converter
        input.installTap(onBus: 0, bufferSize: 2048, format: format) { [weak self] buffer, _ in
            guard let self else { return }
            let samples = downsample(buffer, converter: converter, target: self.target)
            self.queue.async { self.consume(samples, track: "mic", now: Date()) }
        }
        do {
            try engine.start()
            self.engine = engine
        } catch {
            emit(["type": "error", "track": "mic", "message": "麦克风启动失败：\(error.localizedDescription)。请在系统设置里允许 DeepSeek Harness 使用麦克风。"])
        }
    }

    func startSystem() {
        // 起不来就退避重试：屏幕录制权限、显示器枚举都可能在启动瞬间失败，
        // 之前只试一次，失败就整场会议都没有系统声音。
        var attempts = 0
        func attempt() {
            attempts += 1
            Task {
                do {
                let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
                guard let display = content.displays.first else {
                    emit(["type": "error", "track": "system", "message": "没有可用的显示器，系统声音未开启"])
                    return
                }
                let filter = SCContentFilter(display: display, excludingApplications: [], exceptingWindows: [])
                let config = SCStreamConfiguration()
                config.capturesAudio = true
                config.excludesCurrentProcessAudio = true
                config.sampleRate = sampleRate
                config.channelCount = 1
                config.width = 2
                config.height = 2
                let stream = SCStream(filter: filter, configuration: config, delegate: self)
                try stream.addStreamOutput(self, type: .audio, sampleHandlerQueue: queue)
                try await stream.startCapture()
                self.stream = stream
                emit(["type": "status", "phase": "running", "mic": self.engine != nil, "system": true, "input": self.inputName])
                } catch {
                    if attempts < 3 {
                        let delay = Double(attempts) * 2
                        try? await Task.sleep(nanoseconds: UInt64(delay * 1_000_000_000))
                        emit(["type": "status", "phase": "running", "mic": self.engine != nil, "system": false, "input": self.inputName])
                        attempt()
                        return
                    }
                    emit(["type": "error", "track": "system", "message": "系统声音未开启：\(error.localizedDescription)。需要给 DeepSeek Harness 屏幕录制权限。麦克风转写仍会继续。"])
                }
            }
        }
        attempt()
    }

    /// 采集流被系统停掉（睡眠、切换显示器、权限变化）时重建。
    func stream(_ stream: SCStream, didStopWithError error: Error) {
        guard self.stream === stream else { return }
        self.stream = nil
        emit(["type": "status", "phase": "running", "mic": self.engine != nil, "system": false, "input": self.inputName])
        startSystem()
    }

    func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of type: SCStreamOutputType) {
        guard type == .audio, let formatDesc = sampleBuffer.formatDescription else { return }
        guard let asbd = CMAudioFormatDescriptionGetStreamBasicDescription(formatDesc)?.pointee else { return }
        guard let block = CMSampleBufferGetDataBuffer(sampleBuffer) else { return }
        var length = 0
        var dataPointer: UnsafeMutablePointer<Int8>?
        guard CMBlockBufferGetDataPointer(block, atOffset: 0, lengthAtOffsetOut: nil, totalLengthOut: &length, dataPointerOut: &dataPointer) == noErr,
              let dataPointer else { return }
        let frames = length / Int(asbd.mBytesPerFrame)
        guard frames > 0 else { return }
        var samples = [Float](repeating: 0, count: frames)
        if asbd.mFormatFlags & kAudioFormatFlagIsFloat != 0 {
            dataPointer.withMemoryRebound(to: Float.self, capacity: frames) { src in
                for i in 0..<frames { samples[i] = src[i * Int(asbd.mChannelsPerFrame)] }
            }
        } else {
            dataPointer.withMemoryRebound(to: Int16.self, capacity: frames) { src in
                for i in 0..<frames { samples[i] = Float(src[i * Int(asbd.mChannelsPerFrame)]) / 32768 }
            }
        }
        consume(samples, track: "system", now: Date())
    }

    func consume(_ samples: [Float], track: String, now: Date) {
        guard !samples.isEmpty else { return }
        rollMinute(now)
        var peak: Float = 0
        for sample in samples {
            let value = abs(sample)
            if value > peak { peak = value }
        }
        if track == "system" {
            systemBuffers += 1
            if peak > systemPeak { systemPeak = peak }
        } else {
            micBuffers += 1
            lastMicBufferAt = now
            if peak > micPeak { micPeak = peak }
        }
        let utterance = track == "system" ? system : mic
        let frames = stride(from: 0, to: samples.count, by: 320).map { Array(samples[$0..<min($0 + 320, samples.count)]) }
        for frame in frames {
            if let done = utterance.push(frame, now: now) {
                let split = utterance.lastSplit
                if split { utterance.lastSplit = false }
                finish(done.flush, track: track, start: done.start, speech: done.speech, end: now, split: split)
            }
        }
    }

    func finish(_ samples: [Float], track: String, start: Date, speech: Double, end: Date, split: Bool = false) {
        guard samples.count >= minSamples else { return }
        if track == "system" { systemSpeech += speech } else { micSpeech += speech }
        var audioPath = ""
        if let audioRoot, mode == "raw" || model == nil {
            let file = URL(fileURLWithPath: audioRoot)
                .appendingPathComponent(track)
                .appendingPathComponent("\(Int(start.timeIntervalSince1970 * 1000)).wav")
            if (try? writeWav(samples, to: file)) != nil { audioPath = file.path }
        }
        if model == nil {
            guard !audioPath.isEmpty else {
                emit(["type": "error", "track": track, "message": "外部转写需要音频目录"])
                return
            }
            emit([
                "type": "utt",
                "track": track,
                "startAt": iso(start),
                "endAt": iso(end),
                "audio": audioPath,
                "speechSeconds": speech,
            ])
            return
        }
        guard let model else { return }
        do {
            let text = try model.transcribePreferred(samples, preference: language)
            guard !text.isEmpty else { return }
            if track == "system" { systemChars += text.count } else { micChars += text.count }
            snippets += 1
            var event: [String: Any] = [
                "type": "snippet",
                "track": track,
                "startAt": iso(start),
                "endAt": iso(end),
                "text": text,
                "speechSeconds": speech,
            ]
            if !audioPath.isEmpty { event["audio"] = audioPath }
            if split { event["split"] = true }
            if let emb = embedder?.embedding(samples) { event["emb"] = emb }
            if track == "mic", !inputName.isEmpty { event["input"] = inputName }
            emit(event)
        } catch {
            emit(["type": "error", "track": track, "message": "转写失败：\(error.localizedDescription)"])
        }
    }

    func rollMinute(_ now: Date) {
        if now.timeIntervalSince(minuteStart) < 60 { return }
        emitActivity(minuteStart)
        minuteStart = now
        micSpeech = 0
        systemSpeech = 0
        micChars = 0
        systemChars = 0
        snippets = 0
        micBuffers = 0
        systemBuffers = 0
        micPeak = 0
        systemPeak = 0
    }

    func emitActivity(_ start: Date) {
        emit([
            "type": "activity",
            "startAt": iso(start),
            "micSpeechSeconds": micSpeech,
            "systemSpeechSeconds": systemSpeech,
            "micChars": micChars,
            "systemChars": systemChars,
            "snippetCount": snippets,
            "micBuffers": micBuffers,
            "systemBuffers": systemBuffers,
            "micPeak": Double(micPeak),
            "systemPeak": Double(systemPeak),
        ])
    }

    func stop() {
        engine?.inputNode.removeTap(onBus: 0)
        engine?.stop()
        if let stream { Task { try? await stream.stopCapture() } }
        if let done = mic.flush() { finish(done.flush, track: "mic", start: done.start, speech: done.speech, end: Date()) }
        if let done = system.flush() { finish(done.flush, track: "system", start: done.start, speech: done.speech, end: Date()) }
        emitActivity(minuteStart)
        emit(["type": "status", "phase": "stopped"])
    }
}

func iso(_ date: Date) -> String {
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    return formatter.string(from: date)
}

let command = CommandLine.arguments.dropFirst().first ?? "help"
if command == "probe" {
    let dir = arg("model") ?? ""
    let model = SenseVoice()
    do {
        try model.load(dir: dir)
        emit(["type": "probe", "ok": true, "kind": "coreml-sensevoice"])
        exit(0)
    } catch {
        emit(["type": "probe", "ok": false, "message": error.localizedDescription])
        exit(1)
    }
}

if command == "inputs" {
    let list = inputDevices().map { device -> [String: Any] in
        ["uid": device.uid, "name": device.name, "default": device.id == defaultInputID()]
    }
    emit(["type": "inputs", "items": list])
    exit(0)
}

#if canImport(AppKit)
if command == "pick" {
    runPick()
}
#endif

if command == "transcribe" {
    guard let path = arg("file"), let modelDir = arg("model") else {
        fputs("usage: asr-helper transcribe --file PATH --model DIR [--language zhen]\n", stderr)
        exit(2)
    }
    runTranscribeFile(path: path, modelDir: modelDir, language: arg("language") ?? "zhen")
}

guard command == "capture" else {
    fputs("usage: asr-helper capture --model DIR [--mode raw|tracks|merged] [--audio DIR] [--input UID]\n       asr-helper capture --engine external --audio DIR [--mode raw|tracks|merged]\n       asr-helper transcribe --file PATH --model DIR [--language zhen]\n       asr-helper pick\n       asr-helper inputs\n", stderr)
    exit(2)
}

let mode = arg("mode") ?? "tracks"
let language = arg("language") ?? "zhen"
let audio = arg("audio")
let external = arg("engine") == "external"
let model: SenseVoice?
if external {
    guard audio != nil else {
        emit(["type": "error", "message": "外部转写需要 --audio"])
        exit(1)
    }
    model = nil
} else {
    guard let modelDir = arg("model") else {
        emit(["type": "error", "message": "缺少 --model"])
        exit(1)
    }
    let loaded = SenseVoice()
    do {
        try loaded.load(dir: modelDir)
    } catch {
        emit(["type": "error", "message": "模型加载失败：\(error.localizedDescription)"])
        exit(1)
    }
    model = loaded
}
let capture = Capture(model: model, mode: mode, language: language, audioRoot: external || mode == "raw" ? audio : nil, inputUID: arg("input"), embedModel: arg("embed-model"))
if arg("no-split-speaker") == nil {
    capture.enableSpeakerSplit(threshold: Float(arg("split-threshold") ?? "") ?? 0.55)
}
signal(SIGINT, SIG_IGN)
signal(SIGTERM, SIG_IGN)
let source = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .main)
source.setEventHandler {
    capture.stop()
    exit(0)
}
source.resume()
signal(SIGTERM, SIG_IGN)
capture.start()
dispatchMain()
