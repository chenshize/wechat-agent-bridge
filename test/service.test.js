import assert from "node:assert/strict";
import test from "node:test";

import { SERVICE_ID, launchAgentPlist, servicePaths, systemdUnit } from "../src/service.js";

test("service paths use user-level launchd and systemd definitions", () => {
  assert.equal(
    servicePaths({ home: "/Users/test", platform: "darwin" }).definition,
    `/Users/test/Library/LaunchAgents/${SERVICE_ID}.plist`,
  );
  assert.equal(
    servicePaths({ home: "/home/test", platform: "linux" }).definition,
    "/home/test/.config/systemd/user/weclaudex.service",
  );
});

test("launchd and systemd definitions pin executable and private state directory", () => {
  const plist = launchAgentPlist({
    nodePath: "/opt/node&bin/node",
    cliPath: "/opt/weclaudex/src/cli.js",
    stateDirectory: "/Users/test/.weclaudex",
    workspace: "/Users/test/project",
    logPath: "/Users/test/.weclaudex/service.log",
  });
  assert.match(plist, /io\.weclaudex\.bridge/);
  assert.match(plist, /\/opt\/node&amp;bin\/node/);
  assert.match(plist, /WECHAT_BRIDGE_STATE_DIR/);
  assert.match(plist, /KeepAlive/);
  assert.match(plist, /WorkingDirectory/);

  const unit = systemdUnit({
    nodePath: "/usr/bin/node",
    cliPath: "/opt/weclaudex/src/cli.js",
    stateDirectory: "/home/test/.weclaudex",
    workspace: "/home/test/project",
  });
  assert.match(unit, /Restart=on-failure/);
  assert.match(unit, /systemd|WeClaudex/i);
  assert.match(unit, /WECHAT_BRIDGE_STATE_DIR/);
  assert.match(unit, /WorkingDirectory="\/home\/test\/project"/);
});
