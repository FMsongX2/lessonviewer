# 슬라이드 정리 함수의 출력 계약을 검증한다.
# 임시 자료만 사용하며 실제 강의자료와 원본 보관함은 변경하지 않는다.
import contextlib
import io
import tempfile
import zipfile
from pathlib import Path
from unittest.mock import patch

import eclass_sort as e

with tempfile.TemporaryDirectory() as tmp:
    root = Path(tmp)
    for case in ('unknown', 'mismatch', 'collision', 'archive'):
        src = root / (case + '.pptx')
        with zipfile.ZipFile(src, 'w') as z:
            if case != 'unknown':
                z.writestr('ppt/slides/slide1.xml', '<slide/>')
        pdf = src.with_name(src.name + '.pdf')
        pdf.write_bytes(b'%PDF-1.7\n/Type /Page\n' * (2 if case == 'mismatch' else 1))
        out = src.with_suffix('.pdf')
        if case == 'collision':
            out.write_bytes(b'keep existing notes')
        stdout, stderr = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
            print(e.archive_slide(src, pdf))
        expected = out if case == 'archive' else pdf
        assert stdout.getvalue().strip() == str(expected), (case, stdout.getvalue())
        assert expected.exists() and stderr.getvalue(), case
        assert src.exists() == (case != 'archive'), case
        if case == 'archive':
            assert (root / e.STASH / src.name).exists()
        if case == 'collision':
            assert out.read_bytes() == b'keep existing notes'
    legacy = root / 'legacy.PPT'
    legacy.write_bytes(b'original legacy input')
    converted = root / 'legacy.pptx'
    with zipfile.ZipFile(converted, 'w') as z:
        z.writestr('ppt/slides/slide1.xml', '<slide/>')
        z.writestr('ppt/slides/slide2.xml', '<slide/>')
    with patch.object(e, 'ensure_fonts'), patch.object(e, 'convert_office', return_value=converted) as convert:
        assert e.slide_count(legacy) == 2
        assert convert.call_args.args[2] == 'pptx'
        assert legacy.read_bytes() == b'original legacy input'
    with patch.object(e, 'ensure_fonts'), patch.object(e, 'convert_office', side_effect=RuntimeError('failed')):
        assert e.slide_count(legacy) == 0
print('archive_slide output and legacy PPT contracts ok')
