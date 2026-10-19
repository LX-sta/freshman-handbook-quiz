# -*- coding: utf-8 -*-
"""把 index.html + css/style.css + js/app.js + js/data.js 合成单文件版。"""
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

html = (ROOT / "index.html").read_text(encoding="utf-8")
css = (ROOT / "css" / "style.css").read_text(encoding="utf-8")
app = (ROOT / "js" / "app.js").read_text(encoding="utf-8")
data = (ROOT / "js" / "data.js").read_text(encoding="utf-8")

out = html
out = out.replace(
    '<link rel="stylesheet" href="css/style.css">',
    "<style>\n" + css + "\n</style>",
)
out = out.replace(
    '<script src="js/data.js"></script>',
    "<script>\n" + data + "\n</script>",
)
out = out.replace(
    '<script src="js/app.js"></script>',
    "<script>\n" + app + "\n</script>",
)

assert "style.css" not in out and "app.js" not in out and "data.js" not in out

dst = ROOT / "新生手册刷题-单文件版.html"
dst.write_text(out, encoding="utf-8")
print("已生成:", dst, f"({dst.stat().st_size/1024:.1f} KB)")
