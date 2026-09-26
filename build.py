"""Bundle index.html + css + js into one standalone file: dist/iot-packet-lab.html"""
import re, pathlib
root = pathlib.Path(__file__).parent
html = (root / "index.html").read_text()
css = (root / "css/style.css").read_text()
html = html.replace('<link rel="stylesheet" href="css/style.css">', "<style>\n" + css + "\n</style>")
def inline(m):
    return "<script>\n" + (root / m.group(1)).read_text() + "\n</script>"
html = re.sub(r'<script src="(js/[a-z]+\.js)"></script>', inline, html)
(root / "dist").mkdir(exist_ok=True)
(root / "dist/iot-packet-lab.html").write_text(html)
print("wrote dist/iot-packet-lab.html", len(html), "bytes")

# Artifact variant: page content only (the host supplies <html>/<head>/<body>)
head = re.search(r"<head>(.*?)</head>", html, re.S).group(1)
head = re.sub(r'<meta[^>]*>\n?', "", head)
body = re.search(r"<body>(.*?)</body>", html, re.S).group(1)
(root / "dist/artifact.html").write_text(head.strip() + "\n" + body.strip() + "\n")
print("wrote dist/artifact.html")
