# Contributing / 参与贡献

感谢你改进 **WeClaudex**。这是一个能够以本地用户身份启动 Coding Agent 的远程入口，因此可靠性、安全边界和向后兼容与功能本身同样重要。

Thanks for improving **WeClaudex**. Because this project remotely launches coding agents as the local OS user, reliability, security boundaries, and backward compatibility matter as much as features.

## 开发流程 / Development workflow

1. 使用 Node.js 22 或更高版本，并从 `main` 创建功能分支。
2. 运行 `npm ci` 安装锁定依赖。
3. 修改行为时补充或更新测试，尤其是重启、重复消息、队列满载、路径逃逸和进程终止等边界。
4. 提交前运行：

   ```bash
   npm run check
   git diff --check
   ```

5. Pull request 请说明行为变化、安全影响、兼容性和验证方式。不要提交微信 token、账号 ID、原始聊天日志、本机绝对路径或其他凭据。

1. Use Node.js 22 or newer and branch from `main`.
2. Install locked dependencies with `npm ci`.
3. Add or update tests for behavioral changes, especially restart, duplicate-message, queue-capacity, path-escape, and process-termination boundaries.
4. Run `npm run check` and `git diff --check` before submitting.
5. Describe behavior, security impact, compatibility, and validation in the pull request. Never commit WeChat tokens, account IDs, raw chat logs, local absolute paths, or other credentials.

## 设计原则 / Design principles

- 保持 Codex、Claude Code 与微信传输层解耦。
- 默认选择安全、显式、可恢复的行为；危险能力必须清楚标注。
- 不静默丢弃持久任务、回复或用户明确选择发送的文件。
- 不把其他项目代码复制进来；提交者必须有权贡献全部代码与素材。
- Keep agent adapters independent from the WeChat transport.
- Prefer safe, explicit, recoverable defaults and label dangerous capabilities clearly.
- Never silently discard durable tasks, final replies, or explicitly selected artifacts.
- Do not copy code from other projects; contributors must have the right to submit all code and assets.
