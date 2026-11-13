// bazhen-notify: shows one of Bazhen's desktop notifications on macOS, through
// UNUserNotificationCenter, under Bazhen's own name.
//
// The daemon launches it through LaunchServices (`open -nW Bazhen.app --args ...`): macOS grants
// notification permission only to a bundle LaunchServices registered, and the first post asks
// the user for it. It is an NSApplication because LaunchServices sends a launched app Apple
// Events; an app with no run loop to answer them is reported "not responding".
//
// Post mode (`--title`): posts, then stays `--timeout` seconds to take a click.
// Response mode (no `--title`): macOS relaunches the bundle when a notification is clicked after
// the instance that posted it has exited; the click is handled the same way.
// `--self-test`: checks the parser and the inbox URL, prints what failed, and exits.
//
// A click opens the daemon's inbox on this machine, built here from the daemon's port: a
// notification carries only that port, so nothing in one can make the app open anything else.

import Cocoa
import UserNotifications

struct Options: Equatable {
    var title: String?
    var body = ""
    var port: Int?
    var timeout: TimeInterval = 5
    var selfTest = false
}

/**
 * The options in `argv`. A known flag takes the argument after it as its value, whatever it
 * starts with; anything else, such as the -psn_ argument macOS may add, is skipped on its own.
 */
func parseOptions(_ argv: [String]) -> Options {
    var options = Options()
    var i = 1
    while i < argv.count {
        let flag = argv[i]
        let value = i + 1 < argv.count ? argv[i + 1] : nil
        switch (flag, value) {
        case ("--title", let v?): options.title = v
        case ("--body", let v?): options.body = v
        case ("--port", let v?):
            let port = Int(v)
            options.port = port.flatMap(inboxURL) == nil ? nil : port
        case ("--timeout", let v?): options.timeout = TimeInterval(v) ?? options.timeout
        case ("--self-test", _):
            options.selfTest = true
            i += 1
            continue
        default:
            i += 1
            continue
        }
        i += 2
    }
    return options
}

/** The daemon's inbox on this machine, on `port`; nil for a port that can't be one. */
func inboxURL(_ port: Int) -> URL? {
    guard (1...65_535).contains(port) else { return nil }
    return URL(string: "http://127.0.0.1:\(port)/#/inbox")
}

/** Each check the parser and the URL must pass; the names of those that failed. */
func selfTest() -> [String] {
    let argv = { (args: [String]) in parseOptions(["bazhen-notify"] + args) }
    var expected = Options()
    expected.title = "--url"
    expected.body = "--port"
    expected.port = 7900
    let checks: [(String, Bool)] = [
        ("a value that looks like a flag stays a value",
         argv(["--title", "--url", "--body", "--port", "--port", "7900"]) == expected),
        ("an unknown argument is skipped on its own",
         argv(["-psn_0_12345", "--title", "t"]).title == "t"),
        ("a flag with no value is ignored", argv(["--title"]).title == nil),
        ("a port that isn't a number is dropped", argv(["--port", "7900?x=1"]).port == nil),
        ("a port out of range is dropped", argv(["--port", "70000"]).port == nil),
        ("the inbox is the daemon's own, on its port",
         inboxURL(7900)?.absoluteString == "http://127.0.0.1:7900/#/inbox"),
        ("no URL for port 0", inboxURL(0) == nil),
        ("self-test is read", argv(["--self-test"]).selfTest),
    ]
    return checks.filter { !$0.1 }.map { $0.0 }
}

final class Delegate: NSObject, NSApplicationDelegate, UNUserNotificationCenterDelegate {
    let options: Options

    init(_ options: Options) {
        self.options = options
        super.init()
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        let center = UNUserNotificationCenter.current()
        center.delegate = self
        if let title = options.title { post(title, center) }
        DispatchQueue.main.asyncAfter(deadline: .now() + options.timeout) { NSApp.terminate(nil) }
    }

    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification,
        withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void
    ) {
        completionHandler([.banner, .sound])
    }

    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse,
        withCompletionHandler completionHandler: @escaping () -> Void
    ) {
        if response.actionIdentifier == UNNotificationDefaultActionIdentifier,
           let port = response.notification.request.content.userInfo["port"] as? Int,
           let url = inboxURL(port) {
            NSWorkspace.shared.open(url)
        }
        completionHandler()
    }

    private func post(_ title: String, _ center: UNUserNotificationCenter) {
        center.requestAuthorization(options: [.alert, .sound]) { granted, _ in
            guard granted else {
                FileHandle.standardError.write(Data("bazhen-notify: notifications are not allowed\n".utf8))
                return
            }
            let content = UNMutableNotificationContent()
            content.title = title
            content.body = self.options.body
            if let port = self.options.port { content.userInfo = ["port": port] }
            let request = UNNotificationRequest(identifier: UUID().uuidString, content: content, trigger: nil)
            center.add(request) { error in
                if let error = error {
                    FileHandle.standardError.write(Data("bazhen-notify: \(error.localizedDescription)\n".utf8))
                }
            }
        }
    }
}

let options = parseOptions(CommandLine.arguments)
if options.selfTest {
    let failed = selfTest()
    for name in failed { FileHandle.standardError.write(Data("self-test failed: \(name)\n".utf8)) }
    exit(failed.isEmpty ? 0 : 1)
}
let app = NSApplication.shared
let delegate = Delegate(options)
app.delegate = delegate
// No Dock icon or menu bar: the notification is all there is to see.
app.setActivationPolicy(.accessory)
app.run()
