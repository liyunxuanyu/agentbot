/**
 * 本机启动脚本（Windows 专用便利入口）。
 *
 * 为什么要它：本机的 ZCode 是桌面应用自带的 CLI（`zcode.cjs`），不在 PATH 上，
 * 而产品靠 `AGENTBOT_BIN_ZCODE` 指定可执行文件路径。直接 `node dist/server.js`
 * 会让 ZCode 显示「未安装」，用户会以为产品坏了。
 *
 * 只做一件事：把本机已知的 ZCode 路径填进环境变量（**已设置则不覆盖**），
 * 然后加载正常的服务端入口。所有行为与 `node dist/server.js` 完全一致。
 *
 * 换机器 / 换安装位置时，改下面的 ZCODE_FALLBACK 即可；或用环境变量覆盖：
 *   AGENTBOT_BIN_ZCODE="D:/somewhere/zcode.cjs" npm run start:local
 */

const ZCODE_FALLBACK = "D:/Program software/ZCode/resources/glm/zcode.cjs";

process.env.AGENTBOT_BIN_ZCODE ??= ZCODE_FALLBACK;

await import("../dist/server.js");
