// Tiny CLI: runs Apple Vision text recognition on an image and prints a JSON
// array of {text, confidence, x, y, w, h} entries. Coordinates are Vision's
// normalised 0–1 with the ORIGIN AT BOTTOM-LEFT (the parser flips Y).
//
// Compile once :  swiftc djay-ocr.swift -O -o djay-ocr
// Run        :   ./djay-ocr screenshot.png > out.json

import Foundation
import Vision
import CoreImage

let args = CommandLine.arguments
guard args.count >= 2 else {
    FileHandle.standardError.write(Data("Usage: djay-ocr <image-path>\n".utf8))
    exit(64)
}

let url = URL(fileURLWithPath: args[1])
guard let ciImage = CIImage(contentsOf: url) else {
    FileHandle.standardError.write(Data("Cannot load image: \(args[1])\n".utf8))
    exit(66)
}

let request = VNRecognizeTextRequest()
request.recognitionLevel = .accurate
request.recognitionLanguages = ["fr-FR", "en-US"]
request.usesLanguageCorrection = true

let handler = VNImageRequestHandler(ciImage: ciImage, options: [:])
do {
    try handler.perform([request])
} catch {
    FileHandle.standardError.write(Data("Vision error: \(error)\n".utf8))
    exit(70)
}

var output: [[String: Any]] = []
for obs in request.results ?? [] {
    guard let cand = obs.topCandidates(1).first else { continue }
    let box = obs.boundingBox
    output.append([
        "text": cand.string,
        "confidence": cand.confidence,
        "x": box.origin.x,
        "y": box.origin.y,
        "w": box.size.width,
        "h": box.size.height,
    ])
}

let json = try JSONSerialization.data(withJSONObject: output, options: [])
FileHandle.standardOutput.write(json)
