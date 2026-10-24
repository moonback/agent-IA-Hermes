// Document extraction on known fixtures (regenerate with: python3 tests/fixtures/make-documents.py).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { deflateRawSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import {
  DOCUMENT_LIMITS,
  decodeXml,
  excelDate,
  extractDocument,
  mammothHtmlToMarkdown,
  readZip,
} from '@hermes/core';

const fixture = (name: string) => readFileSync(join(import.meta.dirname, '../fixtures', name));

/** Builds a one-entry zip whose central directory declares the given sizes and flags. */
function zipWith(name: string, data: Buffer, opts: { flags?: number; declaredSize?: number } = {}) {
  const comp = deflateRawSync(data);
  const n = Buffer.from(name);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(8, 8);
  local.writeUInt32LE(comp.length, 18);
  local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(n.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(opts.flags ?? 0, 8);
  central.writeUInt16LE(8, 10);
  central.writeUInt32LE(comp.length, 20);
  central.writeUInt32LE(opts.declaredSize ?? data.length, 24);
  central.writeUInt16LE(n.length, 28);
  central.writeUInt32LE(0, 42);
  const cdOffset = local.length + n.length + comp.length;
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(1, 8);
  eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(central.length + n.length, 12);
  eocd.writeUInt32LE(cdOffset, 16);
  return Buffer.concat([local, n, comp, central, n, eocd]);
}

describe('PDF (pdf.js)', () => {
  it('extrait le texte page par page et les métadonnées', async () => {
    const d = await extractDocument(fixture('rapport.pdf'), 'pdf');
    expect(d).toMatchObject({ format: 'pdf', pages: 2, pagesRead: 2, truncated: false });
    expect(d.text).toContain('--- Page 1 ---\nRapport annuel HERMES - page 1');
    expect(d.text).toContain('Conclusion : objectifs atteints (page 2)');
    expect(d.metadata).toMatchObject({ title: 'Rapport annuel', author: 'Équipe HERMES' });
  });
  it('ne lit que 100 pages et le signale', async () => {
    const d = await extractDocument(fixture('long.pdf'), 'pdf');
    expect(d).toMatchObject({ pages: 105, pagesRead: DOCUMENT_LIMITS.maxPages, truncated: true });
    expect(d.text).toContain('Page numéro 100');
    expect(d.text).not.toContain('Page numéro 101');
    expect(d.warnings[0]).toMatch(/100 premières pages sur 105/);
  });
  it('refuse proprement un PDF corrompu', async () => {
    await expect(extractDocument(Buffer.from('%PDF-1.4 rien'), 'pdf')).rejects.toThrow(/PDF illisible/);
  });
});

describe('DOCX (mammoth → Markdown)', () => {
  it('conserve titres, emphase et tableau', async () => {
    const d = await extractDocument(fixture('note.docx'), 'docx');
    expect(d.format).toBe('docx');
    expect(d.text).toMatch(/^# Compte rendu de réunion/);
    expect(d.text).toContain('Décision : **lancer le projet HERMES**');
    expect(d.text).toContain('| Action | Responsable |\n| --- | --- |\n| Rédiger le plan | Alice |');
    expect(d.text).toMatch(/Prochaine réunion lundi\.$/);
  });
});

describe('HTML de mammoth → Markdown', () => {
  it('convertit listes, liens et échappe les barres dans les cellules', () => {
    expect(
      mammothHtmlToMarkdown(
        '<h2>Titre</h2><ul><li>un</li><li><em>deux</em></li></ul><p>Voir <a href="https://x.fr">le site</a></p><table><tr><td>a|b</td></tr></table>',
      ),
    ).toBe('## Titre\n\n- un\n- _deux_\n\nVoir [le site](https://x.fr)\n\n| a\\|b |\n| --- |');
  });
});

describe('XLSX (lecteur intégré)', () => {
  it('lit les feuilles, chaînes partagées, nombres, formules, dates, booléens et chaînes en ligne', async () => {
    const d = await extractDocument(fixture('budget.xlsx'), 'xlsx');
    expect(d.sheets!.map((s) => s.name)).toEqual(['Budget', 'Notes & remarques']);
    expect(d.sheets![0]!.rows).toEqual([
      ['Poste', 'Montant', 'Échéance'],
      ['Loyer', 850, '2026-01-01'],
      ['Courses', 412.5],
      [],
      ['Total', 1262.5],
    ]);
    expect(d.sheets![1]!.rows).toEqual([['Remarque : budget validé', true]]);
    expect(d.text).toContain('## Feuille : Budget\nPoste\tMontant\tÉchéance\nLoyer\t850\t2026-01-01');
  });
  it('dates Excel et entités XML', () => {
    expect(excelDate(46023)).toBe('2026-01-01');
    expect(excelDate(46023.5)).toBe('2026-01-01 12:00:00');
    expect(decodeXml('&lt;a&gt; &amp; &#233;&#x20AC;')).toBe('<a> & é€');
  });
});

describe('archives ZIP défensives', () => {
  it('lit une entrée valide', () => {
    expect(readZip(zipWith('a.txt', Buffer.from('bonjour'))).get('a.txt')!().toString()).toBe('bonjour');
  });
  it('refuse les documents chiffrés, les bombes zip et les archives invalides', () => {
    expect(() => readZip(zipWith('a.txt', Buffer.from('x'), { flags: 1 }))).toThrow(/chiffré/);
    expect(() => readZip(zipWith('a.txt', Buffer.from('x'), { declaredSize: 2 ** 31 }))).toThrow(
      /volumineux/,
    );
    // A lying declared size is still bounded by the real inflation limit.
    const bomb = zipWith('b.txt', Buffer.alloc(DOCUMENT_LIMITS.maxEntryBytes + 1024), { declaredSize: 10 });
    expect(() => readZip(bomb).get('b.txt')!()).toThrow();
    expect(() => readZip(Buffer.from('pas une archive zip, vraiment pas'))).toThrow(/ZIP invalide/);
  });
  it('signale un XLSX ou DOCX sans partie principale', async () => {
    await expect(extractDocument(zipWith('x.txt', Buffer.from('x')), 'xlsx')).rejects.toThrow(/workbook/);
    await expect(extractDocument(zipWith('x.txt', Buffer.from('x')), 'docx')).rejects.toThrow(
      /document\.xml/,
    );
  });
});
