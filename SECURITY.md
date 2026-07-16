# Security Policy / 安全策略

**WeClaudex** 是本地 Coding Agent 的远程入口。安全问题可能导致未授权的本机命令执行、文件读取、凭据泄露或错误的消息/文件投递，请负责任地披露。

**WeClaudex** is a remote entry point to local coding agents. Security issues may lead to unauthorized local execution, file access, credential disclosure, or incorrect message/file delivery; please disclose them responsibly.

## 报告漏洞 / Reporting a vulnerability

优先使用 GitHub 仓库的 **Security → Report a vulnerability** 私密报告功能。请不要在公开 Issue 中粘贴 token、微信账号 ID、上下文 token、原始聊天日志或可利用细节。

Prefer the repository's private **Security → Report a vulnerability** flow. Do not paste tokens, WeChat account IDs, context tokens, raw chat logs, or exploitable details into a public issue.

报告中请包含：受影响版本、最小复现步骤、预期与实际行为、影响范围，以及已经采取的缓解措施。维护者确认并准备修复前，请避免公开利用细节。

Include the affected version, minimal reproduction, expected and actual behavior, impact, and any mitigation already applied. Please avoid public disclosure of exploit details until the issue is confirmed and a fix is ready.

## 支持范围 / Supported scope

安全修复面向最新发布版本。微信 iLink/ClawBot 协议属于外部依赖，协议变化造成的普通兼容问题不一定是安全漏洞；绕过发送者白名单、工作区边界、access 模式、敏感文件拦截、状态权限或出站完整性校验的问题应按安全问题报告。

Security fixes target the latest release. Ordinary compatibility breakage caused by changes to the external WeChat iLink/ClawBot protocol may not be a vulnerability. Bypasses of sender allowlists, workspace boundaries, access modes, sensitive-file blocking, state permissions, or outbound integrity checks should be reported as security issues.
