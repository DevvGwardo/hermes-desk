import Foundation
import CoreGraphics

// Read-only OS cursor position. Does not post events or move/focus any window.
if let point = CGEvent(source: nil)?.location {
    print("{\"x\":\(point.x),\"y\":\(point.y)}")
} else {
    exit(1)
}
