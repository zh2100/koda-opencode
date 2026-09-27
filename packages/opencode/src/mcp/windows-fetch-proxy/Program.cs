using System;
using System.Collections.Generic;
using System.IO;
using System.Net;
using System.Text;
using System.Web.Script.Serialization;
class McpProxy {
  static int Main() {
    ServicePointManager.SecurityProtocol = (SecurityProtocolType)3072 | (SecurityProtocolType)768 | (SecurityProtocolType)192;
    var input = Console.OpenStandardInput();
    var output = Console.OpenStandardOutput();
    var serializer = new JavaScriptSerializer();
    while (true) {
      int length = ReadInt(input);
      if (length < 0) return 0;
      var bytes = ReadExactly(input, length);
      var request = serializer.Deserialize<Dictionary<string, object>>(Encoding.UTF8.GetString(bytes));
      var url = Convert.ToString(request["url"]);
      var method = Convert.ToString(request["method"]);
      var body = request.ContainsKey("body") ? Convert.ToString(request["body"]) : "";
      var req = (HttpWebRequest)WebRequest.Create(url);
      req.Method = method;
      if (request.ContainsKey("headers")) {
        var headers = (Dictionary<string, object>)request["headers"];
        foreach (var entry in headers) {
          var key = entry.Key;
          var value = Convert.ToString(entry.Value) ?? "";
          if (key.Equals("content-type", StringComparison.OrdinalIgnoreCase)) req.ContentType = value;
          else if (key.Equals("accept", StringComparison.OrdinalIgnoreCase)) req.Accept = value;
          else if (key.Equals("user-agent", StringComparison.OrdinalIgnoreCase)) req.UserAgent = value;
          else if (key.Equals("host", StringComparison.OrdinalIgnoreCase) || key.Equals("connection", StringComparison.OrdinalIgnoreCase) || key.Equals("content-length", StringComparison.OrdinalIgnoreCase)) continue;
          else req.Headers[key] = value;
        }
      }
      if (!string.IsNullOrEmpty(body)) {
        if (string.IsNullOrEmpty(req.ContentType)) req.ContentType = "application/json";
        var payload = Encoding.UTF8.GetBytes(body);
        req.ContentLength = payload.Length;
        using (var stream = req.GetRequestStream()) stream.Write(payload, 0, payload.Length);
      }
      HttpWebResponse res = null;
      try { res = (HttpWebResponse)req.GetResponse(); }
      catch (WebException ex) { res = (HttpWebResponse)ex.Response; if (res == null) throw; }
      var responseHeaders = new Dictionary<string, string>();
      foreach (var key in res.Headers.AllKeys) responseHeaders[key] = res.Headers[key];
      string text;
      using (var reader = new StreamReader(res.GetResponseStream(), Encoding.UTF8)) text = reader.ReadToEnd();
      var response = serializer.Serialize(new Dictionary<string, object> {
        { "status", (int)res.StatusCode },
        { "headers", responseHeaders },
        { "body", text },
      });
      var responseBytes = Encoding.UTF8.GetBytes(response);
      var prefix = BitConverter.GetBytes(responseBytes.Length);
      output.Write(prefix, 0, prefix.Length);
      output.Write(responseBytes, 0, responseBytes.Length);
      output.Flush();
    }
  }

  static int ReadInt(Stream stream) {
    var bytes = ReadExactly(stream, 4);
    if (bytes == null) return -1;
    return BitConverter.ToInt32(bytes, 0);
  }

  static byte[] ReadExactly(Stream stream, int length) {
    var bytes = new byte[length];
    var offset = 0;
    while (offset < length) {
      var read = stream.Read(bytes, offset, length - offset);
      if (read == 0) return offset == 0 ? null : bytes;
      offset += read;
    }
    return bytes;
  }
}
