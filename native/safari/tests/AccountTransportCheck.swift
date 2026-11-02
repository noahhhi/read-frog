import Foundation
final class MockAccountServer: URLProtocol {
 override class func canInit(with request: URLRequest) -> Bool { true }
 override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
 override func startLoading() {
  precondition(request.value(forHTTPHeaderField: "Cookie") == "__Secure-better-auth.session_token=test-token")
  let response = HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: "HTTP/1.1", headerFields: ["Content-Type": "application/json", "Set-Cookie": "__Secure-better-auth.session_token=; Domain=.readfrog.app; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax"])!
  client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
  client?.urlProtocol(self, didLoad: Data("{\"user\":null}".utf8))
  client?.urlProtocolDidFinishLoading(self)
 }
 override func stopLoading() {}
}
@main struct Check {
 static func main() throws {
  let good = "https://api.readfrog.app/api/identity/get-session"
  func message(_ url: String = "https://api.readfrog.app/api/identity/get-session") -> [String: Any] {
   ["url": url, "method": "GET", "headers": [["Host", "evil.test"], ["Cookie", "bad"], ["Origin", "https://evil.test"], ["accept", "application/json"], ["x-orpc-source", "extension"], ["x-read-frog-client-context", "test-context"]],
    "cookies": [["name": "__Secure-better-auth.session_token", "value": "test-token"]]]
  }
  let req = try AccountHTTPTransport.makeRequest(message(good))
  precondition(req.value(forHTTPHeaderField: "Cookie") == "__Secure-better-auth.session_token=test-token")
  precondition(req.value(forHTTPHeaderField: "Origin") == "https://www.readfrog.app")
  precondition(req.value(forHTTPHeaderField: "Host") == nil)
  precondition(req.value(forHTTPHeaderField: "x-orpc-source") == "extension")
  precondition(req.value(forHTTPHeaderField: "x-read-frog-client-context") == "test-context")
  precondition(!req.httpShouldHandleCookies)
  for url in ["https://api.readfrog.app.evil.test/api/identity/get-session", "http://api.readfrog.app/api/identity/get-session", "https://user@api.readfrog.app/api/rpc/x", "https://api.readfrog.app:444/api/rpc/x", "https://api.readfrog.app/api/identity-extra/x"] {
   do { _ = try AccountHTTPTransport.makeRequest(message(url)); fatalError("Accepted forbidden URL") } catch {}
  }
  var bad = message()
  bad["cookies"] = [["name": "other_cookie", "value": "private"]]
  do { _ = try AccountHTTPTransport.makeRequest(bad); fatalError("Accepted unrelated cookie") } catch {}
  bad["cookies"] = [["name": "better-auth.session_token", "value": "foo\r\nHost: evil"]]
  do { _ = try AccountHTTPTransport.makeRequest(bad); fatalError("Accepted header injection") } catch {}
  let transport = AccountHTTPTransport()
  let config = URLSessionConfiguration.ephemeral
  config.protocolClasses = [MockAccountServer.self]
  var completed = false
  transport.start(req, configuration: config) { response in
   precondition(response["error"] == nil)
   precondition(response["status"] as? Int == 200)
   let body = Data(base64Encoded: response["body"] as! String)!
   precondition(String(data: body, encoding: .utf8) == "{\"user\":null}")
   let updates = response["cookies"] as! [[String: Any]]
   precondition(updates.count == 1)
   precondition((updates[0]["expirationDate"] as? Double ?? .infinity) <= Date().timeIntervalSince1970)
   precondition(updates[0]["httpOnly"] as? Bool == true)
   precondition(updates[0]["secure"] as? Bool == true)
   precondition(!(response["headers"] as! [[String]]).contains { $0[0].lowercased() == "set-cookie" })
   completed = true
  }
  let deadline = Date().addingTimeInterval(5)
  while !completed && Date() < deadline { RunLoop.current.run(until: Date().addingTimeInterval(0.01)) }
  precondition(completed)
  print("Native destination, header, cookie and ephemeral-request checks passed")
 }
}
