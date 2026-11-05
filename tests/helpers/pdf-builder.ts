/**
 * Minimal deterministic PDF 1.4 generator for testing multi-page PDF text extraction (`pdfjs-dist`).
 * Each page entry contains an array of lines (drawn top-to-bottom in Helvetica).
 */
export function buildTestPdf(pages: string[][]): Buffer {
	const objects: string[] = [];
	const addObject = (body: string): number => {
		objects.push(body);
		return objects.length;
	};

	const catalogId = addObject(""); // placeholder 1
	const pagesId = addObject(""); // placeholder 2
	const fontId = addObject("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");

	const pageIds: number[] = [];

	const escapePdfString = (s: string): string =>
		s.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");

	for (const lines of pages) {
		const streamLines: string[] = [];
		let y = 740;
		for (const line of lines) {
			if (!line) {
				y -= 18;
				continue;
			}
			streamLines.push(`BT /F1 11 Tf 54 ${y} Td (${escapePdfString(line)}) Tj ET`);
			y -= 15;
		}
		const streamContent = streamLines.join("\n");
		const contentId = addObject(
			`<< /Length ${Buffer.byteLength(streamContent, "utf8")} >>\nstream\n${streamContent}\nendstream`,
		);
		const pageId = addObject(
			`<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${fontId} 0 R >> >> /Contents ${contentId} 0 R >>`,
		);
		pageIds.push(pageId);
	}

	objects[catalogId - 1] = `<< /Type /Catalog /Pages ${pagesId} 0 R >>`;
	objects[pagesId - 1] = `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pageIds.length} >>`;

	const parts: string[] = ["%PDF-1.4\n"];
	const offsets: number[] = [0];
	let currentOffset = Buffer.byteLength(parts[0], "utf8");

	for (let i = 0; i < objects.length; i++) {
		offsets.push(currentOffset);
		const objStr = `${i + 1} 0 obj\n${objects[i]}\nendobj\n`;
		parts.push(objStr);
		currentOffset += Buffer.byteLength(objStr, "utf8");
	}

	const xrefOffset = currentOffset;
	const xrefLines: string[] = [
		"xref",
		`0 ${objects.length + 1}`,
		"0000000000 65535 f ",
	];
	for (let i = 1; i <= objects.length; i++) {
		xrefLines.push(`${String(offsets[i]).padStart(10, "0")} 00000 n `);
	}
	const trailer = [
		...xrefLines,
		"trailer",
		`<< /Size ${objects.length + 1} /Root ${catalogId} 0 R >>`,
		"startxref",
		String(xrefOffset),
		"%%EOF\n",
	].join("\n");
	parts.push(trailer);

	return Buffer.from(parts.join(""), "utf8");
}
