import AVFoundation
import CoreAudio
import CoreML
import Foundation
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
    var converter: AVAudioConverter?
    var stream: SCStream?
    let target = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: Double(sampleRate), channels: 1, interleaved: false)!
    /// 指定输入设备（UID）；为空则跟随系统默认。
    let inputUID: String?
    private(set) var inputName = ""

    init(model: SenseVoice?, mode: String, language: String, audioRoot: String?, inputUID: String?) {
        self.model = model
        self.mode = mode
        self.language = language
        self.audioRoot = audioRoot
        self.inputUID = inputUID
        super.init()
    }

    func start() {
        startMic()
        startSystem()
        minuteStart = Date()
        emit(["type": "status", "phase": "running", "mic": engine != nil, "system": stream != nil, "input": inputName])
    }

    func startMic() {
        let engine = AVAudioEngine()
        let input = engine.inputNode
        // 先把输入设备切到指定的那个（耳机麦 / 内置麦），再读格式。
        let devices = inputDevices()
        let chosen = inputUID.flatMap { uid in devices.first { $0.uid == uid } }
        if let chosen, let unit = input.audioUnit {
            var device = chosen.id
            let status = AudioUnitSetProperty(unit, kAudioOutputUnitProperty_CurrentDevice,
                                              kAudioUnitScope_Global, 0, &device,
                                              UInt32(MemoryLayout<AudioDeviceID>.size))
            if status != noErr {
                emit(["type": "error", "track": "mic", "message": "切换输入设备失败：\(chosen.name)"])
            }
        }
        let actualID = chosen?.id ?? defaultInputID()
        inputName = devices.first { $0.id == actualID }?.name ?? ""
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
            if peak > micPeak { micPeak = peak }
        }
        let utterance = track == "system" ? system : mic
        let frames = stride(from: 0, to: samples.count, by: 320).map { Array(samples[$0..<min($0 + 320, samples.count)]) }
        for frame in frames {
            if let done = utterance.push(frame, now: now) {
                finish(done.flush, track: track, start: done.start, speech: done.speech, end: now)
            }
        }
    }

    func finish(_ samples: [Float], track: String, start: Date, speech: Double, end: Date) {
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

guard command == "capture" else {
    fputs("usage: asr-helper capture --model DIR [--mode raw|tracks|merged] [--audio DIR] [--input UID]\n       asr-helper capture --engine external --audio DIR [--mode raw|tracks|merged]\n       asr-helper inputs\n", stderr)
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
let capture = Capture(model: model, mode: mode, language: language, audioRoot: external || mode == "raw" ? audio : nil, inputUID: arg("input"))
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
