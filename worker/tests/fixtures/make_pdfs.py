"""Regenerates the PDF fixtures: `uv run python tests/fixtures/make_pdfs.py` (from worker/)."""

from pathlib import Path

import pymupdf

HERE = Path(__file__).parent

PAGES = [
    "What databases and SQL are. A relational database stores data in tables made of rows and columns. "
    "Each row is one record and each column holds one kind of value. A primary key identifies each row, "
    "and a foreign key points at a row in another table. SQL is the language used to work with these tables.",
    "Querying with SELECT. The SELECT statement retrieves data from one table. Write SELECT, the columns, "
    "FROM and the table name. Rename columns with AS and remove duplicates with SELECT DISTINCT. "
    "Filtering with WHERE keeps only the rows that match a condition, using comparison and logical operators.",
    "Joining tables. Joins combine rows from related tables. An inner join keeps rows that match in both tables, "
    "and a left join keeps every row from the left table. Keys link tables together: the foreign key in one "
    "table matches the primary key in the other.",
]


def write_text_pdf(path: Path, pages: list[str], title: str, **save) -> None:
    doc = pymupdf.open()
    for text in pages:
        page = doc.new_page()
        page.insert_textbox(pymupdf.Rect(50, 50, 550, 800), text, fontsize=11)
    doc.set_metadata({"title": title})
    doc.save(path, **save)


def write_scanned_pdf(path: Path) -> None:
    doc = pymupdf.open()
    for _ in range(2):
        page = doc.new_page()
        pix = pymupdf.Pixmap(pymupdf.csRGB, pymupdf.IRect(0, 0, 200, 100), False)
        pix.clear_with(200)
        page.insert_image(pymupdf.Rect(50, 50, 450, 250), pixmap=pix)
    doc.save(path)


if __name__ == "__main__":
    write_text_pdf(HERE / "sql_basics.pdf", PAGES, "SQL basics")
    write_scanned_pdf(HERE / "scanned.pdf")
    write_text_pdf(
        HERE / "encrypted.pdf",
        PAGES[:1],
        "Locked",
        encryption=pymupdf.PDF_ENCRYPT_AES_256,
        owner_pw="owner",
        user_pw="secret",
    )
