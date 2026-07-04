# Web 工具

`webfetch` 获取一个已知 HTTP(S) URL，返回有界文本。它不搜索、不执行 JavaScript、不点击链接、不提交表单、不访问本机或私网。

## 参数

```ts
webfetch({
  url: string,
  mode?: "readable" | "source",
  offset?: number,
  limit?: number,
})
```

- `readable`：HTML 清理后转 Markdown；JSON、XML、纯文本保持原文。
- `source`：返回解码后的响应源码文本。
- `offset`/`limit`：对首次转换后的内存 snapshot 切片；继续读取长页面时用上次返回的 `next_offset`。

## 配置

配置文件：`agent/configs/web-tools.jsonc`。

- `timeout_seconds`：单次调用总超时。
- `max_redirects`：手动重定向次数上限。
- `user_agent`：固定 User-Agent，不由模型参数控制。
- `network.fake_ip_ranges`：Clash/mihomo TUN fake-ip CIDR。默认空；只支持 `198.18.0.0/15` 内的子网。
- `limits.response_bytes`：解压后正文硬上限。
- `limits.default_output_chars` / `max_output_chars`：返回给模型的字符预算。

未知字段会被 schema 拒绝。

## Cookie

默认 Cookie 文件：`agent/cookies.txt`，格式为 Netscape/Mozilla `cookies.txt`。

Unix 权限必须禁止 group/other 读取：

```bash
chmod 600 ~/.pi/agent/cookies.txt
```

Cookie 发送需同时满足：

- `cookies.enabled` 为 `true`；
- `cookies.domains` 命中目标 host；
- `cookies.txt` 自身的 domain/path/secure/expiry 匹配。

allowlist 规则：

- `example.com` 只匹配 `example.com`；
- `*.example.com` 只匹配子域名，不匹配裸域。

认证确认：

- `always`：每次发送 Cookie 前询问；
- `session`：每个 origin 每会话首次询问；
- `never`：命中 allowlist 后直接发送。

响应 `Set-Cookie` 只更新内存 CookieJar，不写回 `cookies.txt`。

## 安全限制

- 只允许 `http:` 和 `https:`。
- 拒绝 URL userinfo、localhost、字面私网 IP。
- 每次连接时 DNS 解析结果必须全部是公网地址。
- 配置的 fake-ip CIDR 只放行域名 DNS 解析结果；URL 直接写 IP 仍会拒绝。
- 每个 redirect 目标重新执行 URL、DNS、Cookie 检查。
- 拒绝二进制和 PDF。
- 错误、renderer、模型输出不包含 Cookie 名称和值。

## 错误码

常见错误包括 `INVALID_URL`、`BLOCKED_ADDRESS`、`COOKIE_ERROR`、`AUTH_CONFIRMATION_REQUIRED`、`DNS_FAILED`、`CONNECTION_FAILED`、`TLS_FAILED`、`TIMEOUT`、`ABORTED`、`TOO_MANY_REDIRECTS`、`HTTP_ERROR`、`RESPONSE_TOO_LARGE`、`UNSUPPORTED_CONTENT_TYPE`、`DECODE_FAILED`、`CONVERSION_FAILED`、`OFFSET_OUT_OF_RANGE`。
