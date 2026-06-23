#!/usr/bin/env python3
from PyPDF2 import PdfReader

reader = PdfReader("idp_template.pdf")
for page in reader.pages:
    print(page.extract_text())
