import Foundation
import SafariServices

// One ephemeral network session per request: neither cookies nor account data
// are retained in an App-owned cookie jar, cache, preferences, or log.
final class AccountHTTPTransport: NSObject, URLSessionDataDelegate {
    static func isAccountURL(_ url: URL) -> Bool {
        url.scheme == "https" && url.host == "api.readfrog.app"
            && (url.port == nil || url.port == 443) && url.user == nil && url.password == nil
            && ["/api/identity", "/api/rpc"].contains { url.path == $0 || url.path.hasPrefix($0 + "/") }
    }

    static func isSessionCookie(_ name: String) -> Bool {
        name.range(of: #"^(?:__Secure-|__Host-)?better-auth\.session_token(?:\.\d+)?$"#, options: .regularExpression) != nil
    }

    static func makeRequest(_ message: [String: Any]) throws -> URLRequest {
        guard let raw = message["url"] as? String, let url = URL(string: raw), isAccountURL(url),
              let method = message["method"] as? String,
              ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"].contains(method),
              let headers = message["headers"] as? [[String]],
              let cookies = message["cookies"] as? [[String: String]] else {
            throw URLError(.badURL)
        }
        var request = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 120)
        request.httpMethod = method
        request.httpShouldHandleCookies = false
        // Drop routing, cookie, browser-origin, and hop-by-hop headers supplied
        // by JS. A fixed official origin is used for the website's CSRF check.
        let allowed = Set(["accept", "content-type", "accept-language", "x-orpc-version", "x-orpc-source", "x-read-frog-client-context", "last-event-id"])
        for pair in headers where pair.count == 2 && allowed.contains(pair[0].lowercased()) {
            guard !pair[1].contains("\r"), !pair[1].contains("\n") else { throw URLError(.badURL) }
            request.setValue(pair[1], forHTTPHeaderField: pair[0])
        }
        let pairs = try cookies.map { cookie -> String in
            guard let name = cookie["name"], let value = cookie["value"], isSessionCookie(name),
                  value.utf8.allSatisfy({ $0 >= 0x21 && $0 <= 0x7e && $0 != 0x3b && $0 != 0x2c && $0 != 0x22 && $0 != 0x5c }) else {
                throw URLError(.badURL)
            }
            return name + "=" + value
        }
        if !pairs.isEmpty { request.setValue(pairs.joined(separator: "; "), forHTTPHeaderField: "Cookie") }
        request.setValue("https://www.readfrog.app", forHTTPHeaderField: "Origin")
        if let bytes = message["body"] as? [UInt8] {
            guard bytes.count <= 8 * 1024 * 1024 else { throw URLError(.dataLengthExceedsMaximum) }
            request.httpBody = Data(bytes)
        }
        return request
    }

    private var session: URLSession?
    private var task: URLSessionDataTask?
    private var response: HTTPURLResponse?
    private var data = Data()
    private var completion: (([String: Any]) -> Void)?

    func start(_ request: URLRequest, configuration: URLSessionConfiguration = .ephemeral,
               completion: @escaping ([String: Any]) -> Void) {
        self.completion = completion
        configuration.httpCookieStorage = nil
        configuration.httpShouldSetCookies = false
        configuration.urlCache = nil
        configuration.timeoutIntervalForResource = 180
        let session = URLSession(configuration: configuration, delegate: self, delegateQueue: .main)
        self.session = session
        task = session.dataTask(with: request)
        task?.resume()
    }

    func cancel() { task?.cancel() }

    func urlSession(_ session: URLSession, task: URLSessionTask,
                    willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest,
                    completionHandler: @escaping (URLRequest?) -> Void) {
        // Never forward a session cookie or mutation to any redirect target.
        completionHandler(nil)
    }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive response: URLResponse,
                    completionHandler: @escaping (URLSession.ResponseDisposition) -> Void) {
        guard let http = response as? HTTPURLResponse, let url = http.url, Self.isAccountURL(url),
              !(300..<400).contains(http.statusCode), response.expectedContentLength <= 8 * 1024 * 1024 else {
            completionHandler(.cancel)
            return
        }
        self.response = http
        completionHandler(.allow)
    }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
        guard self.data.count + data.count <= 8 * 1024 * 1024 else { dataTask.cancel(); return }
        self.data.append(data)
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        defer {
            completion = nil
            data.removeAll()
            self.task = nil
            self.session = nil
            session.invalidateAndCancel()
        }
        guard error == nil, let response, let url = response.url else {
            completion?(["error": "Safari account request failed"])
            return
        }
        var fields: [String: String] = [:]
        var headers: [[String]] = []
        for (key, value) in response.allHeaderFields {
            let name = String(describing: key), value = String(describing: value)
            fields[name] = value
            if !["set-cookie", "content-length", "content-encoding", "transfer-encoding"].contains(name.lowercased()) {
                headers.append([name, value])
            }
        }
        let cookies: [[String: Any]] = HTTPCookie.cookies(withResponseHeaderFields: fields, for: url).compactMap { cookie in
            guard Self.isSessionCookie(cookie.name), ["readfrog.app", "api.readfrog.app"].contains(cookie.domain.trimmingCharacters(in: CharacterSet(charactersIn: "."))) else { return nil }
            var value: [String: Any] = ["name": cookie.name, "value": cookie.value,
                "domain": cookie.domain, "path": cookie.path, "secure": cookie.isSecure,
                "httpOnly": cookie.isHTTPOnly, "sameSite": "lax"]
            if let expires = cookie.expiresDate { value["expirationDate"] = expires.timeIntervalSince1970 }
            if let age = cookie.properties?[.maximumAge] as? String, let seconds = Double(age) {
                value["expirationDate"] = Date().timeIntervalSince1970 + seconds
            }
            // Foundation retains SameSite on supported macOS versions.
            if let sameSite = cookie.properties?[HTTPCookiePropertyKey("SameSite")] as? String {
                value["sameSite"] = ["strict": "strict", "none": "no_restriction"][sameSite.lowercased()] ?? "lax"
            }
            return value
        }
        completion?(["status": response.statusCode, "headers": headers,
                     "body": data.base64EncodedString(), "cookies": cookies])
    }
}

class SafariWebExtensionHandler: NSObject, NSExtensionRequestHandling {
    // Confine registry access to the main queue and namespace it by Safari
    // profile. No request can reuse another profile's session or cancel its work.
    private static var requests: [String: AccountHTTPTransport] = [:]

    func beginRequest(with context: NSExtensionContext) {
        let item = context.inputItems.first as? NSExtensionItem
        let message = item?.userInfo?[SFExtensionMessageKey] as? [String: Any]
        let profile = (item?.userInfo?[SFExtensionProfileKey] as? UUID)?.uuidString ?? "default"
        DispatchQueue.main.async {
            func reply(_ value: [String: Any]) {
                let item = NSExtensionItem()
                item.userInfo = [SFExtensionMessageKey: value]
                context.completeRequest(returningItems: [item], completionHandler: nil)
            }
            guard let message, let id = message["id"] as? String, UUID(uuidString: id) != nil else {
                reply(["error": "Invalid account message"])
                return
            }
            let key = profile + ":" + id
            if message["type"] as? String == "read-frog-account-cancel" {
                Self.requests[key]?.cancel()
                reply(["cancelled": true])
                return
            }
            guard message["type"] as? String == "read-frog-account-fetch",
                  Self.requests[key] == nil, Self.requests.count < 32 else {
                reply(["error": "Invalid account request"])
                return
            }
            do {
                let request = try AccountHTTPTransport.makeRequest(message)
                let transport = AccountHTTPTransport()
                Self.requests[key] = transport
                transport.start(request) { result in
                    Self.requests.removeValue(forKey: key)
                    reply(result)
                }
            } catch {
                reply(["error": "Invalid account request"])
            }
        }
    }
}
