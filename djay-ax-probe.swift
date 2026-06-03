// Probes djay's accessibility hierarchy to see whether the library table
// (Titre / Artiste / BPM / Clé) is reachable via macOS Accessibility APIs.
// Output is a structured dump that tells us if going down the AX path is
// worth it — versus staying on OCR.
//
// Compile :  swiftc djay-ax-probe.swift -framework AppKit -framework ApplicationServices -O -o djay-ax-probe
// First run will prompt for Accessibility permission. Authorise the binary
// in System Settings → Privacy & Security → Accessibility, then re-run.

import Foundation
import AppKit
import ApplicationServices

let BUNDLE_ID = "com.algoriddim.djay-iphone-free"
let MAX_DEPTH = 8        // don't drown in noise
let MAX_CHILDREN = 12    // sample per level

func findDjay() -> NSRunningApplication? {
    return NSWorkspace.shared.runningApplications.first { $0.bundleIdentifier == BUNDLE_ID }
}

func axString(_ el: AXUIElement, _ attr: String) -> String? {
    var v: CFTypeRef?
    let err = AXUIElementCopyAttributeValue(el, attr as CFString, &v)
    if err == .success, let s = v as? String, !s.isEmpty { return s }
    return nil
}

func axChildren(_ el: AXUIElement) -> [AXUIElement] {
    var v: CFTypeRef?
    let err = AXUIElementCopyAttributeValue(el, kAXChildrenAttribute as CFString, &v)
    guard err == .success, let arr = v as? [AXUIElement] else { return [] }
    return arr
}

func describe(_ el: AXUIElement) -> String {
    let role = axString(el, kAXRoleAttribute) ?? "—"
    let sub = axString(el, kAXSubroleAttribute) ?? ""
    let title = axString(el, kAXTitleAttribute) ?? ""
    let value = axString(el, kAXValueAttribute) ?? ""
    let desc = axString(el, kAXDescriptionAttribute) ?? ""
    let identifier = axString(el, "AXIdentifier") ?? ""
    var parts = ["role=\(role)"]
    if !sub.isEmpty { parts.append("subrole=\(sub)") }
    if !title.isEmpty { parts.append("title=\"\(title.prefix(60))\"") }
    if !value.isEmpty { parts.append("value=\"\(value.prefix(60))\"") }
    if !desc.isEmpty { parts.append("desc=\"\(desc.prefix(60))\"") }
    if !identifier.isEmpty { parts.append("id=\"\(identifier.prefix(60))\"") }
    return parts.joined(separator: "  ")
}

var totalNodes = 0
var matchingRoles: [String: Int] = [:]

func walk(_ el: AXUIElement, depth: Int) {
    totalNodes += 1
    let role = axString(el, kAXRoleAttribute) ?? "—"
    matchingRoles[role, default: 0] += 1

    let pad = String(repeating: "  ", count: depth)
    print("\(pad)\(describe(el))")

    if depth >= MAX_DEPTH { return }
    let kids = axChildren(el)
    for kid in kids.prefix(MAX_CHILDREN) {
        walk(kid, depth: depth + 1)
    }
    if kids.count > MAX_CHILDREN {
        print("\(pad)  ... +\(kids.count - MAX_CHILDREN) more siblings")
    }
}

guard let djay = findDjay() else {
    FileHandle.standardError.write(Data("❌ djay Pro pas en cours d'exécution (\(BUNDLE_ID))\n".utf8))
    exit(1)
}

print("✓ djay Pro PID \(djay.processIdentifier) trouvé\n")

let app = AXUIElementCreateApplication(djay.processIdentifier)

// Trigger the AX trust prompt if needed
let trusted = AXIsProcessTrustedWithOptions(["AXTrustedCheckOptionPrompt": kCFBooleanTrue] as CFDictionary)
if !trusted {
    FileHandle.standardError.write(Data("⚠️  Le binaire n'a pas la permission Accessibility — autorise-le dans\n   System Settings → Privacy & Security → Accessibility, puis relance.\n".utf8))
    exit(2)
}

// Give the user 3 seconds to put djay Pro back in the foreground after
// launching the probe from the terminal (otherwise the terminal grabs focus
// and djay's focused-window state is empty). Bringing djay forward
// programmatically would force us to inspect a state we didn't choose, so
// we just wait and then read whatever windows djay exposes.
FileHandle.standardError.write(Data("⏳ 3 secondes pour passer djay au premier plan…\n".utf8))
Thread.sleep(forTimeInterval: 3.0)

// Try several ways to grab a usable window. Focused first, then main, then
// the first window in the array. Catalyst apps sometimes expose the table
// only via the main window even when something else is focused.
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

guard let windowEl = usableWindow() else {
    print("❌ djay ne montre aucune fenêtre AX")
    exit(3)
}

let winTitle = axString(windowEl, kAXTitleAttribute) ?? "(sans titre)"
print("=== Fenêtre cible : \"\(winTitle)\" ===\n")
print("=== Arbre Accessibility de djay (max \(MAX_DEPTH) niveaux, \(MAX_CHILDREN) enfants/niveau) ===\n")
walk(windowEl, depth: 0)

print("\n=== Statistiques ===")
print("Total nœuds visités : \(totalNodes)")
print("Rôles rencontrés :")
for (role, count) in matchingRoles.sorted(by: { $0.value > $1.value }) {
    print("  \(role.padding(toLength: 30, withPad: " ", startingAt: 0)) \(count)")
}
