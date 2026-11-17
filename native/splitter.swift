// 说话人切换检测：在 VAD 切句的基础上，再按声纹判断「换人了」。
//
// 为什么需要：能量 VAD 只认静音间隔。两个人快速接话（间隔 < 900ms）时，
// 会被当成一句连续的发言，转写出一条，声纹也只能给一个人。
//
// 做法：拿到一段话后，每隔一小段（默认 1.6 秒）取窗口声纹，和这段话开头的
// 锚点比余弦。连续两次明显不像 → 判为换人，在两次窗口之间切开。
// 用「连续两次」而不是一次，是为了扛住咳嗽、键盘、语气剧烈变化造成的误切。

import Foundation

/// 两个向量的余弦相似度；长度不一致或空向量返回 0。
public func cosineSimilarity(_ a: [Float], _ b: [Float]) -> Float {
    let n = min(a.count, b.count)
    if n == 0 { return 0 }
    var dot: Float = 0
    var na: Float = 0
    var nb: Float = 0
    for i in 0..<n {
        dot += a[i] * b[i]
        na += a[i] * a[i]
        nb += b[i] * b[i]
    }
    if na <= 0 || nb <= 0 { return 0 }
    return dot / (na.squareRoot() * nb.squareRoot())
}

/// 判定「同一段话里换人了」。
public struct SpeakerSplitter {
    /// 低于这个相似度就算「不像同一个人」。
    public let threshold: Float
    /// 需要连续命中几次才切（1 太敏感，2 比较稳）。
    public let confirmations: Int
    /// 这段话开头的声纹锚点。
    private var anchor: [Float]?
    /// 当前连续命中的次数。
    private var strikes = 0

    public init(threshold: Float = 0.55, confirmations: Int = 2) {
        self.threshold = threshold
        self.confirmations = max(1, confirmations)
    }

    /// 喂一个窗口的声纹；返回 true 表示应当在这里切开。
    /// 每个窗口只会被判定一次，切开后锚点换成新窗口（新的一段从这个人重新起算）。
    public mutating func observe(_ vector: [Float]) -> Bool {
        guard !vector.isEmpty else { return false }
        guard let current = anchor else {
            anchor = vector
            strikes = 0
            return false
        }
        let similarity = cosineSimilarity(current, vector)
        lastSimilarity = similarity
        if similarity >= threshold {
            strikes = 0
            return false
        }
        strikes += 1
        if strikes >= confirmations {
            // 切开后新的一段以当前窗口为锚点，避免连续误切
            anchor = vector
            strikes = 0
            return true
        }
        return false
    }

    /// 一句话结束后重置，下一句重新取锚点。
    public mutating func reset() {
        anchor = nil
        strikes = 0
    }

    /// 当前锚点与最近一次窗口的相似度（用于调试/日志）。
    public private(set) var lastSimilarity: Float = 0
}
