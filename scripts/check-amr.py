import zipfile
import hashlib
import json

path = r"D:\douyin\8001790389478283.1_0_0.amr"
raw = open(path, "rb").read()
lines = ["size = %d bytes" % len(raw)]
if raw[:2] == b"PK":
    z = zipfile.ZipFile(path)
    for info in z.infolist():
        lines.append("  %-24s %8d bytes" % (info.filename, info.file_size))
    m = json.loads(z.read("manifest.json"))
    for fname, meta in (m.get("cert") or {}).items():
        if fname in z.namelist():
            actual = hashlib.md5(z.read(fname)).hexdigest()
            lines.append("  cert %s md5 match=%s" % (fname, actual == meta.get("md5")))
    print("\n".join(lines))
else:
    print("not a zip")
