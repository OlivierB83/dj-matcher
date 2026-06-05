// djay-ax-extract.swift
//
// Reads djay Pro's library table directly through macOS Accessibility APIs
// and prints a JSON array of row dictionaries:
//   [
//     { "cells": ["A caus' des garçons", "A Caus' Des Garçons", "116", "D"] },
//     …
//   ]
//
// One row = one track. The downstream Node consumer (djay-import.js with
// --ax mode) classifies each cell into title / artist / bpm / key the same
// way it does for OCR fragments.
//
// Compile :  swiftc djay-ax-extract.swift -framework AppKit -framework ApplicationServices -O -o djay-ax-extract
// Run     :  ./djay-ax-extract > /tmp/djay-rows.json
//
// Permissions: djay must be running with a library/playlist view open, and
// the binary needs Accessibility permission (System Settings → Privacy &
// Security → Accessibility).

import Foundation
import AppKit
import ApplicationServices

let BUNDLE_ID = "com.algoriddim.djay-iphone-free"
// (The 3 s countdown that used to live here is now handled by the wrapper
// djay-import-all.sh — it shows the message BEFORE the user is told to flip
// to djay, which is the only sensible order.)

func findDjay() -> NSRunningApplication? {
    NSWorkspace.shared.runningApplications.first { $0.bundleIdentifier == BUNDLE_ID }
}

func axString(_ el: AXUIElement, _ attr: String) -> String? {
    var v: CFTypeRef?
    if AXUIElementCopyAttributeValue(el, attr as CFString, &v) == .success,
       let s = v as? String, !s.isEmpty { return s }
    return nil
}

func axChildren(_ el: AXUIElement) -> [AXUIElement] {
    var v: CFTypeRef?
    if AXUIElementCopyAttributeValue(el, kAXChildrenAttribute as CFString, &v) == .success,
       let arr = v as? [AXUIElement] { return arr }
    return []
}

func axRole(_ el: AXUIElement) -> String { axString(el, kAXRoleAttribute) ?? "" }

/// Recursively flatten descendants matching role, with hard depth and
/// fan-out caps. Catalyst's accessibility hierarchy is a sea of nested
/// AXGroup containers — without these caps the walk explodes into
/// millions of nodes and a multi-minute wall-clock time.
func descendants(_ el: AXUIElement, withRole role: String, maxDepth: Int = 8, maxChildren: Int = 12) -> [AXUIElement] {
    var out: [AXUIElement] = []
    func walk(_ node: AXUIElement, _ depth: Int) {
        if axRole(node) == role { out.append(node) }
        if depth >= maxDepth { return }
        let kids = axChildren(node)
        for kid in kids.prefix(maxChildren) { walk(kid, depth + 1) }
    }
    walk(el, 0)
    return out
}

/// AXTable exposes its rows directly via kAXRowsAttribute. Faster + more
/// reliable than the recursive walk, which on Catalyst can take a long
/// time because every cell is wrapped in multiple AXGroup layers.
func tableRows(_ table: AXUIElement) -> [AXUIElement] {
    for attr in [kAXRowsAttribute, kAXVisibleRowsAttribute] {
        var ref: CFTypeRef?
        if AXUIElementCopyAttributeValue(table, attr as CFString, &ref) == .success,
           let arr = ref as? [AXUIElement], !arr.isEmpty {
            return arr
        }
    }
    // Fallback to the recursive walk if the table doesn't speak the
    // standard rows attribute (some Catalyst tables don't).
    return descendants(table, withRole: kAXRowRole)
}

/// Same idea — try direct attributes on the row before recursing.
func rowCells(_ row: AXUIElement) -> [AXUIElement] {
    for attr in ["AXVisibleCells", "AXCells"] {
        var ref: CFTypeRef?
        if AXUIElementCopyAttributeValue(row, attr as CFString, &ref) == .success,
           let arr = ref as? [AXUIElement], !arr.isEmpty {
            return arr
        }
    }
    return descendants(row, withRole: kAXCellRole, maxDepth: 4)
}

/// Best-effort text content of a cell: try value / title / description, or
/// recurse into the cell's children to find an AXStaticText.
func cellText(_ cell: AXUIElement) -> String {
    if let v = axString(cell, kAXValueAttribute) { return v }
    if let t = axString(cell, kAXTitleAttribute) { return t }
    if let d = axString(cell, kAXDescriptionAttribute) { return d }
    let texts = descendants(cell, withRole: kAXStaticTextRole)
        .compactMap { axString($0, kAXValueAttribute) ?? axString($0, kAXTitleAttribute) }
        .filter { !$0.isEmpty }
    return texts.joined(separator: " ")
}

guard let djay = findDjay() else {
    FileHandle.standardError.write(Data("❌ djay Pro pas en cours d'exécution (\(BUNDLE_ID))\n".utf8))
    exit(1)
}

// Permission check + AX prompt
let trusted = AXIsProcessTrustedWithOptions(["AXTrustedCheckOptionPrompt": kCFBooleanTrue] as CFDictionary)
if !trusted {
    FileHandle.standardError.write(Data("⚠️  Accessibility refusée — autorise dans System Settings → Privacy & Security → Accessibility puis relance.\n".utf8))
    exit(2)
}

let app = AXUIElementCreateApplication(djay.processIdentifier)

// Catalyst apps can be slow to reply to AX calls and a hung call would
// otherwise freeze the whole probe. 2 s per attribute access keeps things
// snappy while still leaving room for the real responses.
AXUIElementSetMessagingTimeout(app, 2.0)
FileHandle.standardError.write(Data("→ timeout AX = 2 s, recherche de la fenêtre…\n".utf8))

// Pick the first usable window
func usableWindow() -> AXUIElement? {
    for attr in [kAXFocusedWindowAttribute, kAXMainWindowAttribute] {
        var ref: CFTypeRef?
        if AXUIElementCopyAttributeValue(app, attr as CFString, &ref) == .success, ref != nil {
            return (ref as! AXUIElement)
        }
    }
    var ref: CFTypeRef?
    if AXUIElementCopyAttributeValue(app, kAXWindowsAttribute as CFString, &ref) == .success,
       let arr = ref as? [AXUIElement], let first = arr.first {
        return first
    }
    return nil
}

guard let window = usableWindow() else {
    FileHandle.standardError.write(Data("❌ djay ne montre aucune fenêtre AX\n".utf8))
    exit(3)
}

let winTitle = axString(window, kAXTitleAttribute) ?? "(sans titre)"
FileHandle.standardError.write(Data("→ fenêtre cible : \"\(winTitle)\" — scan des AXTable…\n".utf8))

// Find all tables. The library track table has ~9 cells per row (cover,
// explicit, etc., duration, title, artist, BPM, key, album). The
// left-hand-side playlist sidebar is also exposed as an AXTable but its
// rows only have ~1-2 cells (playlist name, optional count). So a "row
// count wins" heuristic picks the wrong table when the active playlist
// is shorter than the sidebar — pick the table where the average row
// has the most cells instead.
let tables = descendants(window, withRole: kAXTableRole)
FileHandle.standardError.write(Data("→ \(tables.count) AXTable(s) détectée(s)\n".utf8))

let MIN_CELLS_PER_TRACK_ROW = 5   // sidebar rows have ≤ 2; track rows have ≥ 9

var bestTable: AXUIElement?
var bestScore = -1
var bestRowCount = 0
for (i, tbl) in tables.enumerated() {
    let rows = tableRows(tbl)
    // Sample the first up-to-3 non-empty rows to estimate cell width
    var avgCells = 0
    var sampled = 0
    for r in rows.prefix(3) {
        let cellCount = rowCells(r).count
        if cellCount > 0 {
            avgCells += cellCount
            sampled += 1
        }
    }
    let avg = sampled > 0 ? avgCells / sampled : 0
    FileHandle.standardError.write(Data("   table[\(i)] : \(rows.count) lignes · ~\(avg) cellules/row\n".utf8))

    // Only consider tables whose rows look like track rows. Among those,
    // keep the biggest by row count (= the library / playlist track list).
    if avg >= MIN_CELLS_PER_TRACK_ROW && rows.count > bestRowCount {
        bestRowCount = rows.count
        bestScore = avg
        bestTable = tbl
    }
}

guard let table = bestTable, bestRowCount > 0 else {
    FileHandle.standardError.write(Data("❌ Aucune table de morceaux trouvée. La playlist sélectionnée est peut-être vide, ou tu n'es pas sur une vue tableau (essaie le mode liste avec les colonnes Titre / Artiste / BPM / Clé visibles).\n".utf8))
    exit(4)
}
FileHandle.standardError.write(Data("→ table retenue : \(bestRowCount) lignes (~\(bestScore) cellules/row)\n".utf8))

let rows = tableRows(table)
FileHandle.standardError.write(Data("→ \(rows.count) lignes dans la table principale\n".utf8))

// Extract cells per row
var output: [[String: Any]] = []
for (idx, row) in rows.enumerated() {
    let cells = rowCells(row)
    if cells.isEmpty { continue }
    let texts = cells.map { cellText($0) }
    if texts.allSatisfy({ $0.isEmpty }) { continue }
    output.append(["cells": texts])
    if (idx + 1) % 50 == 0 {
        FileHandle.standardError.write(Data("   \(idx + 1)/\(rows.count) lignes traitées\n".utf8))
    }
}

FileHandle.standardError.write(Data("→ \(output.count) lignes non vides extraites\n".utf8))

let json = try JSONSerialization.data(withJSONObject: output, options: [.prettyPrinted, .sortedKeys])
FileHandle.standardOutput.write(json)
FileHandle.standardOutput.write(Data("\n".utf8))
