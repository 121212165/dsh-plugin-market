"""M5 发布门禁验收（无 dsh 运行时：用构建产物 lib/ + headless 宿主完成实装实调）。

用法：python verify-m5.py
输出：m5-gates.json（门禁断言）、m5-smoke-evidence.json（实装实调证据）、m5-report.json
"""
import json
import re
import subprocess
from pathlib import Path

HERE = Path(__file__).resolve().parent
errors = []
steps = {}


def run(name, cmd):
    proc = subprocess.run(
        cmd, cwd=HERE, shell=True, capture_output=True, text=True,
        encoding="utf-8", errors="replace",
    )
    out = (proc.stdout or "") + (proc.stderr or "")
    ok = proc.returncode == 0
    steps[name] = {"ok": ok, "returncode": proc.returncode, "tail": out[-1500:]}
    if not ok:
        errors.append(f"{name} 失败（退出码 {proc.returncode}）：{out[-800:]}")
    return proc, out


# 1. 先构建，保证门禁/冒烟跑的是最新 lib/（含 locales 与 client）
run("build_all", "npm run build:all")

# 2. G0-5/6/7/8/9/10 本地等价门禁
proc, out = run("verify_plugin", "node scripts/verify-plugin.mjs --json")
try:
    gates = json.loads(proc.stdout)
except Exception as exc:  # noqa: BLE001
    gates = {"pass": False, "gates": [], "parseError": str(exc)}
    errors.append(f"m5-gates.json 解析失败：{exc}")
gate_pass = bool(gates.get("pass")) and all(g.get("ok") for g in gates.get("gates", []))
if not gate_pass:
    for gate in gates.get("gates", []):
        if not gate.get("ok"):
            errors.append(f"{gate['id']} FAIL: {gate['problems']}")

# 3. 类型检查 + 三层测试
run("typecheck", "npm run typecheck")
proc, out = run("tests", "npm test")
m = re.search(r"(?:^|\s)pass\s+(\d+)\b", out, re.M)
f = re.search(r"(?:^|\s)fail\s+(\d+)\b", out, re.M)
passed = int(m.group(1)) if m else 0
failed = int(f.group(1)) if f else -1
test_ok = steps["tests"]["ok"] and failed == 0 and passed >= 50

# 4. 三层测试文件存在性（结构证据，门禁 G0-10 已含，这里再独立确认）
required_layers = [
    "纯函数", ["test/reader.test.ts", "test/render.test.ts", "test/conflicts.test.ts"],
    "装配层", ["test/wire.test.ts", "test/install-wire.test.ts"],
    "headless 冒烟", ["test/headless-smoke.test.mjs"],
]
layers_ok = True
layer_evidence = {}
for i in range(0, len(required_layers), 2):
    name, files = required_layers[i], required_layers[i + 1]
    found = [p for p in files if (HERE / p).exists()]
    layer_evidence[name] = found
    if not found:
        layers_ok = False
        errors.append(f"{name}层测试文件缺失")

# 5. 全新 profile 实装实调证据（headless smoke 产出）
smoke_path = HERE / "m5-smoke-evidence.json"
smoke = json.loads(smoke_path.read_text(encoding="utf-8")) if smoke_path.exists() else {}
smoke_ok = (
    smoke.get("artifact") == "lib/plugin.js"
    and smoke.get("installOrder") == smoke.get("membersExpected")
    and len(smoke.get("calls", [])) == smoke.get("expectedEntryCount", -1)
    and smoke.get("verifyPassed") is True
)
if not smoke_ok:
    errors.append("headless 实装实调证据不完整或不一致")

# 6. lib/ 入库（G0-9 的独立佐证）
lib_required = [
    "lib/index.js", "lib/plugin.js", "lib/client.js", "lib/snapshot.json",
    "lib/locales/zh-CN.json", "lib/core/installer.js", "lib/types/index.d.ts",
]
lib_ok = all((HERE / p).exists() for p in lib_required)
if not lib_ok:
    errors.append("lib/ 构建产物不齐")

criteria = {
    "verify_plugin_gates_all_green": gate_pass,
    "lib_committed": lib_ok,
    "three_layer_tests_present": layers_ok,
    "typecheck_pass": steps["typecheck"]["ok"],
    "tests_pass": test_ok,
    "headless_fresh_profile_install_and_call": smoke_ok,
}

report = {
    "milestone": "M5 — 可发布",
    "generatedAt": None,
    "criteria": criteria,
    "gates": gates.get("gates", []),
    "gateNote": gates.get("note", ""),
    "tests": {"pass": passed, "fail": failed},
    "layers": layer_evidence,
    "smoke": smoke,
    "steps": {name: {"ok": info["ok"], "returncode": info["returncode"]} for name, info in steps.items()},
    "errors": errors,
    "pass": all(criteria.values()) and not errors,
}
from datetime import datetime, timezone
report["generatedAt"] = datetime.now(timezone.utc).isoformat()
(HERE / "m5-report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
print(json.dumps(criteria, ensure_ascii=False, indent=2))
print("PASS" if report["pass"] else "FAIL: " + "; ".join(errors))
raise SystemExit(0 if report["pass"] else 1)
