"""Regenerates the document fixtures used by tests/unit/documents.test.ts.

Usage: python3 tests/fixtures/make-documents.py
Writes rapport.pdf (2 pages), long.pdf (105 pages), note.docx and budget.xlsx next to this file.
Files are built by hand (no third-party library) so their exact content is known.
"""
import os
import zipfile

HERE = os.path.dirname(os.path.abspath(__file__))


def pdf(path, pages, title=None, author=None):
    """Minimal valid PDF: one Helvetica text line per page, WinAnsi encoding, correct xref."""
    objs = []

    def add(body):
        objs.append(body)
        return len(objs)

    font = add(b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>")
    pages_id = len(objs) + 1 + 2 * len(pages)
    kids = []
    for text in pages:
        data = text.encode("cp1252").replace(b"\\", b"\\\\").replace(b"(", b"\\(").replace(b")", b"\\)")
        stream = b"BT /F1 14 Tf 72 720 Td (" + data + b") Tj ET"
        content = add(b"<< /Length %d >>\nstream\n" % len(stream) + stream + b"\nendstream")
        kids.append(
            add(
                b"<< /Type /Page /Parent %d 0 R /MediaBox [0 0 612 792] /Contents %d 0 R /Resources << /Font << /F1 %d 0 R >> >> >>"
                % (pages_id, content, font)
            )
        )
    assert add(b"<< /Type /Pages /Kids [" + b" ".join(b"%d 0 R" % k for k in kids) + b"] /Count %d >>" % len(kids)) == pages_id
    catalog = add(b"<< /Type /Catalog /Pages %d 0 R >>" % pages_id)
    info = None
    if title or author:
        fields = b""
        if title:
            fields += b" /Title (" + title.encode("cp1252") + b")"
        if author:
            fields += b" /Author (" + author.encode("cp1252") + b")"
        info = add(b"<<" + fields + b" >>")
    out = bytearray(b"%PDF-1.4\n%\xe2\xe3\xcf\xd3\n")
    offsets = []
    for i, body in enumerate(objs, 1):
        offsets.append(len(out))
        out += b"%d 0 obj\n" % i + body + b"\nendobj\n"
    xref = len(out)
    out += b"xref\n0 %d\n0000000000 65535 f \n" % (len(objs) + 1)
    for o in offsets:
        out += b"%010d 00000 n \n" % o
    trailer = b"<< /Size %d /Root %d 0 R" % (len(objs) + 1, catalog)
    if info:
        trailer += b" /Info %d 0 R" % info
    out += b"trailer\n" + trailer + b" >>\nstartxref\n%d\n%%%%EOF\n" % xref
    with open(path, "wb") as f:
        f.write(out)


def zip_write(path, files):
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as z:
        for name, data in files.items():
            z.writestr(name, data)


W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"'


def docx(path):
    body = (
        '<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Compte rendu de réunion</w:t></w:r></w:p>'
        '<w:p><w:r><w:t xml:space="preserve">Décision : </w:t></w:r><w:r><w:rPr><w:b/></w:rPr><w:t>lancer le projet HERMES</w:t></w:r></w:p>'
        "<w:tbl><w:tr><w:tc><w:p><w:r><w:t>Action</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>Responsable</w:t></w:r></w:p></w:tc></w:tr>"
        "<w:tr><w:tc><w:p><w:r><w:t>Rédiger le plan</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>Alice</w:t></w:r></w:p></w:tc></w:tr></w:tbl>"
        '<w:p><w:r><w:t>Prochaine réunion lundi.</w:t></w:r></w:p>'
    )
    zip_write(
        path,
        {
            "[Content_Types].xml": '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/></Types>',
            "_rels/.rels": '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
            "word/_rels/document.xml.rels": '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>',
            "word/styles.xml": f'<?xml version="1.0" encoding="UTF-8"?><w:styles {W}><w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/></w:style></w:styles>',
            "word/document.xml": f'<?xml version="1.0" encoding="UTF-8"?><w:document {W}><w:body>{body}</w:body></w:document>',
        },
    )


S = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"'
R = 'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"'


def xlsx(path):
    shared = ["Poste", "Montant", "Loyer", "Courses", "Total", "Échéance"]
    sst = "".join(f"<si><t>{s}</t></si>" for s in shared)
    sheet1 = (
        '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="C1" t="s"><v>5</v></c></row>'
        '<row r="2"><c r="A2" t="s"><v>2</v></c><c r="B2"><v>850</v></c><c r="C2" s="1"><v>46023</v></c></row>'
        '<row r="3"><c r="A3" t="s"><v>3</v></c><c r="B3"><v>412.5</v></c></row>'
        '<row r="5"><c r="A5" t="s"><v>4</v></c><c r="B5"><f>SUM(B2:B3)</f><v>1262.5</v></c></row>'
    )
    sheet2 = '<row r="1"><c r="A1" t="inlineStr"><is><t>Remarque : budget validé</t></is></c><c r="B1" t="b"><v>1</v></c></row>'
    zip_write(
        path,
        {
            "[Content_Types].xml": '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/></Types>',
            "_rels/.rels": '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>',
            "xl/workbook.xml": f'<?xml version="1.0" encoding="UTF-8"?><workbook {S} {R}><sheets><sheet name="Budget" sheetId="1" r:id="rId1"/><sheet name="Notes &amp; remarques" sheetId="2" r:id="rId2"/></sheets></workbook>',
            "xl/_rels/workbook.xml.rels": '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="/xl/worksheets/sheet2.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/><Relationship Id="rId4" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>',
            "xl/styles.xml": f'<?xml version="1.0" encoding="UTF-8"?><styleSheet {S}><cellXfs count="2"><xf numFmtId="0"/><xf numFmtId="14" applyNumberFormat="1"/></cellXfs></styleSheet>',
            "xl/sharedStrings.xml": f'<?xml version="1.0" encoding="UTF-8"?><sst {S} count="{len(shared)}" uniqueCount="{len(shared)}">{sst}</sst>',
            "xl/worksheets/sheet1.xml": f'<?xml version="1.0" encoding="UTF-8"?><worksheet {S}><sheetData>{sheet1}</sheetData></worksheet>',
            "xl/worksheets/sheet2.xml": f'<?xml version="1.0" encoding="UTF-8"?><worksheet {S}><sheetData>{sheet2}</sheetData></worksheet>',
        },
    )


pdf(os.path.join(HERE, "rapport.pdf"), ["Rapport annuel HERMES - page 1", "Conclusion : objectifs atteints (page 2)"], title="Rapport annuel", author="Équipe HERMES")
pdf(os.path.join(HERE, "long.pdf"), [f"Page numéro {i + 1}" for i in range(105)])
docx(os.path.join(HERE, "note.docx"))
xlsx(os.path.join(HERE, "budget.xlsx"))
print("fixtures écrites dans", HERE)
