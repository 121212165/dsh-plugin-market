"""M3 视觉/几何验收（无 dsh 运行时，用真实 lib/client.js + 宿主 token 模拟页）。

用法：python verify-m3.py
输出：.screenshots/m3-{width}-{theme}.png + m3-report.json
"""
import json
from pathlib import Path

from playwright.sync_api import sync_playwright

HERE = Path(__file__).resolve().parent
SHOTS = HERE.parent / ".screenshots"
SHOTS.mkdir(exist_ok=True)
URL = (HERE / "preview.html").as_uri()

WIDTHS = [320, 360, 414, 1280]
THEMES = ["light", "dark"]
CAPTURE = {(360, "light"), (360, "dark"), (1280, "light"), (1280, "dark")}

results = []
errors = []

with sync_playwright() as p:
    browser = p.chromium.launch(channel="msedge", headless=True)
    page = browser.new_page(viewport={"width": 1280, "height": 900}, device_scale_factor=1)
    console_errors = []
    page.on("pageerror", lambda e: console_errors.append(str(e)))

    for theme in THEMES:
        for width in WIDTHS:
            page.set_viewport_size({"width": width, "height": 900})
            page.goto(URL, wait_until="load")
            page.evaluate("t => { document.documentElement.dataset.theme = t; }", theme)
            page.wait_for_selector("[data-market-card]")

            m = page.evaluate(
                """() => {
                  const root = document.getElementById('root');
                  const cards = [...document.querySelectorAll('[data-market-card]')];
                  const grid = cards[0]?.parentElement;
                  return {
                    innerWidth: window.innerWidth,
                    docScrollWidth: document.documentElement.scrollWidth,
                    bodyScrollWidth: document.body.scrollWidth,
                    rootScrollWidth: root.scrollWidth,
                    rootClientWidth: root.clientWidth,
                    cardCount: cards.length,
                    gridColumns: grid ? getComputedStyle(grid).gridTemplateColumns : '',
                    cardBg: cards.length ? getComputedStyle(cards[0]).backgroundColor : '',
                    cardMinWidth: cards.length ? getComputedStyle(cards[0]).minWidth : '',
                    cardBoxSizing: cards.length ? getComputedStyle(cards[0]).boxSizing : '',
                  };
                }"""
            )

            overflow = (
                m["docScrollWidth"] > m["innerWidth"]
                or m["bodyScrollWidth"] > m["innerWidth"]
                or m["rootScrollWidth"] > m["rootClientWidth"]
            )
            track_count = len(m["gridColumns"].split()) if m["gridColumns"] else 0
            ok = (not overflow) and m["cardCount"] == 5 and track_count >= 1
            row = {
                "theme": theme, "width": width, "ok": ok,
                "overflow": overflow, "tracks": track_count,
                **m,
            }
            results.append(row)

            if overflow:
                errors.append(f"{theme}@{width}: 横向溢出 doc={m['docScrollWidth']} inner={m['innerWidth']}")
            if m["cardCount"] != 5:
                errors.append(f"{theme}@{width}: 卡片数 = {m['cardCount']}，应为 5")
            if width <= 414 and track_count != 1:
                errors.append(f"{theme}@{width}: 窄屏应单列，实际 {track_count} 列")

            if (width, theme) in CAPTURE:
                shot = SHOTS / f"m3-{width}-{theme}.png"
                page.screenshot(path=str(shot), full_page=True)
                row["screenshot"] = shot.name

    # 同一 token 名在深浅主题下必须解析出不同颜色（证明深浅色走同一套语义 token）
    light = next(r for r in results if r["width"] == 1280 and r["theme"] == "light")
    dark = next(r for r in results if r["width"] == 1280 and r["theme"] == "dark")
    token_theme_ok = light["cardBg"] != dark["cardBg"]
    if not token_theme_ok:
        errors.append("深浅主题下卡片背景未随 token 变化")

    if console_errors:
        errors.append("页面脚本异常：" + " | ".join(console_errors))

    browser.close()

report = {
    "criteria": {
        "five_cards": all(r["cardCount"] == 5 for r in results),
        "no_horizontal_overflow": all(not r["overflow"] for r in results),
        "narrow_single_column": all(r["tracks"] == 1 for r in results if r["width"] <= 414),
        "token_themes_resolve_differently": token_theme_ok,
    },
    "checks": results,
    "errors": errors,
    "pass": not errors,
}
(HERE / "m3-report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
print(json.dumps(report["criteria"], ensure_ascii=False, indent=2))
print("PASS" if report["pass"] else "FAIL: " + "; ".join(errors))
raise SystemExit(0 if report["pass"] else 1)
