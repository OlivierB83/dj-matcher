// Tiny CLI: runs Apple Vision text recognition on an image and prints a JSON
// array of {text, confidence, x, y, w, h} entries. Coordinates are normalised
// 0–1 of the FULL image with the origin at BOTTOM-LEFT (the parser flips Y).
//
// Long screenshots (a djay-Pro library scroll-capture can easily be 20 000+
// pixels tall) blow past Vision's per-image limit and come back empty. We
// tile the image vertically into ~8 000 px chunks, run Vision on each, and
// re-base the bounding boxes to the full image so the downstream parser
// behaves as if the whole thing went through in one pass.
//
// Compile once :  swiftc djay-ocr.swift -O -o djay-ocr
// Run        :   ./djay-ocr screenshot.png > out.json

import Foundation
import Vision
import CoreImage

let TILE_HEIGHT: CGFloat = 8000   // safely under Vision's ~16 384 px ceiling
let TILE_OVERLAP: CGFloat = 120   // rows at the seam are captured by both tiles

let args = CommandLine.arguments
guard args.count >= 2 else {
    FileHandle.standardError.write(Data("Usage: djay-ocr <image-path>\n".utf8))
    exit(64)
}

let url = URL(fileURLWithPath: args[1])
guard let fullImage = CIImage(contentsOf: url) else {
    FileHandle.standardError.write(Data("Cannot load image: \(args[1])\n".utf8))
    exit(66)
}

let fullW = fullImage.extent.width
let fullH = fullImage.extent.height

func ocrTile(_ tile: CIImage, tileY: CGFloat, tileH: CGFloat) throws -> [[String: Any]] {
    // Three-pass strategy:
    //   pass A — full tile, language correction ON, fr/en hints. Best for
    //           long text (titles, artists, album names).
    //   pass B — full tile, language correction OFF, no language hint.
    //           Catches the rightmost columns Vision otherwise drops as
    //           low-confidence short tokens: BPM numbers and 2-char keys
    //           (Ab, F#m, Bb…).
    //   pass C — rightmost 17 % strip, magnified 3× before OCR. Required
    //           to catch single-letter Camelot keys (G, B, C, D, E, F) —
    //           at native resolution Vision filters them out as noise.

    let tileW = tile.extent.width

    func runPass(on image: CIImage, languageCorrection: Bool, langs: [String]) throws -> [VNRecognizedTextObservation] {
        let req = VNRecognizeTextRequest()
        req.recognitionLevel = .accurate
        req.recognitionLanguages = langs
        req.usesLanguageCorrection = languageCorrection
        let handler = VNImageRequestHandler(ciImage: image, options: [:])
        try handler.perform([req])
        return req.results ?? []
    }

    let resultsA = try runPass(on: tile, languageCorrection: true,  langs: ["fr-FR", "en-US"])
    let resultsB = try runPass(on: tile, languageCorrection: false, langs: [])

    var out: [[String: Any]] = []

    // Passes A + B: coordinates are already in normalised TILE space.
    for obs in resultsA + resultsB {
        guard let cand = obs.topCandidates(1).first else { continue }
        let box = obs.boundingBox
        let globalY = (tileY + box.origin.y * tileH) / fullH
        let globalH = (box.size.height * tileH) / fullH
        out.append([
            "text": cand.string,
            "confidence": cand.confidence,
            "x": box.origin.x,
            "y": globalY,
            "w": box.size.width,
            "h": globalH,
        ])
    }

    // Pass C: crop right 17 %, magnify 3×, OCR. Then re-base coordinates back
    // to the parent TILE frame and to global image space.
    let stripStartX = tile.extent.minX + tileW * CGFloat(0.83)
    let stripWidth = tileW * CGFloat(0.17)
    let stripRect = CGRect(x: stripStartX, y: tile.extent.minY, width: stripWidth, height: tileH)
    let strip = tile.cropped(to: stripRect)
    let zoom: CGFloat = 3.0
    let zoomed = strip
        .transformed(by: CGAffineTransform(translationX: -stripStartX, y: -tile.extent.minY))
        .transformed(by: CGAffineTransform(scaleX: zoom, y: zoom))

    let resultsC = try runPass(on: zoomed, languageCorrection: false, langs: [])

    for obs in resultsC {
        guard let cand = obs.topCandidates(1).first else { continue }
        let box = obs.boundingBox
        // Box is normalised to the ZOOMED-STRIP frame. Convert back:
        // - X: strip starts at 0.83 of tile width and is 0.17 wide
        let xInTile = 0.83 + box.origin.x * 0.17
        let wInTile = box.size.width * 0.17
        // - Y: strip = full tileH, so direct mapping after zoom-normalisation
        let yInTile = box.origin.y
        let hInTile = box.size.height
        let globalY = (tileY + yInTile * tileH) / fullH
        let globalH = (hInTile * tileH) / fullH
        out.append([
            "text": cand.string,
            "confidence": cand.confidence,
            "x": xInTile,
            "y": globalY,
            "w": wInTile,
            "h": globalH,
        ])
    }

    return out
}

var allFragments: [[String: Any]] = []

if fullH <= TILE_HEIGHT {
    // Small image: single pass, no tiling
    do {
        allFragments = try ocrTile(fullImage, tileY: 0, tileH: fullH)
    } catch {
        FileHandle.standardError.write(Data("Vision error: \(error)\n".utf8))
        exit(70)
    }
} else {
    // Tall image: tile vertically. CIImage Y=0 sits at the BOTTOM, so we
    // walk tiles from top to bottom (decreasing CIImage y).
    var topY = fullH
    while topY > 0 {
        let h = min(TILE_HEIGHT, topY)
        let tileBottomY = topY - h
        let rect = CGRect(x: 0, y: tileBottomY, width: fullW, height: h)
        let tile = fullImage.cropped(to: rect)
        // Vision wants its own image frame, so we translate the tile back
        // to (0, 0):
        let translated = tile.transformed(by: CGAffineTransform(translationX: 0, y: -tileBottomY))
        do {
            let frags = try ocrTile(translated, tileY: tileBottomY, tileH: h)
            allFragments.append(contentsOf: frags)
        } catch {
            FileHandle.standardError.write(Data("Vision error on tile y=\(tileBottomY): \(error)\n".utf8))
            // Don't abort — keep going so the user still gets the rest
        }
        topY -= (TILE_HEIGHT - TILE_OVERLAP)
    }
}

// Dedup fragments produced by the overlap zones (a row at the seam shows up
// in both neighbouring tiles). Two detections of the same text within 0.3 %
// of image height are merged into one.
struct Key: Hashable {
    let text: String
    let roundedX: Int
    let roundedY: Int
}
var seen = Set<Key>()
var deduped: [[String: Any]] = []
deduped.reserveCapacity(allFragments.count)
for f in allFragments {
    let text = (f["text"] as? String) ?? ""
    let x = (f["x"] as? Double) ?? 0
    let y = (f["y"] as? Double) ?? 0
    let k = Key(text: text, roundedX: Int(x * 200), roundedY: Int(y * 333))
    if seen.contains(k) { continue }
    seen.insert(k)
    deduped.append(f)
}

let json = try JSONSerialization.data(withJSONObject: deduped, options: [])
FileHandle.standardOutput.write(json)
