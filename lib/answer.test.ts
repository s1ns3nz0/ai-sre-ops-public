import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseAnswer } from './answer.ts';

test('structured answer, Korean body with English headings', () => {
  const a = parseAnswer('## Conclusion\n알림이 오래됐습니다. 재시작 불필요.\n## Evidence\n- heap 28%\n## Next step\nSEV 4로 낮추세요.\n## Details\n가설…');
  assert.deepEqual(a, { conclusion: '알림이 오래됐습니다. 재시작 불필요.', evidence: '- heap 28%', next: 'SEV 4로 낮추세요.', details: '가설…' });
});

test('unstructured: first paragraph is the conclusion', () => {
  assert.deepEqual(parseAnswer('Mostly yes.\nmaru-0 is Ready.\n\nMore detail.'), { conclusion: 'Mostly yes.\nmaru-0 is Ready.', evidence: '', next: '', details: 'More detail.' });
  assert.equal(parseAnswer('**Phase: Verify.**\n## Next step for the IC\nClose it.').next, 'Close it.');
  assert.equal(parseAnswer('**Phase: Verify.**\n## Next step for the IC\nClose it.').conclusion, '**Phase: Verify.**');
});
