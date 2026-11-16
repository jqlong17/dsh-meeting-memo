#!/usr/bin/env python3
"""声纹可行性验证：用已标注片段做留一验证，再用质心给全天片段分配说话人。

用法: python3 scripts/speaker-eval.py [日期]
需要: npm run build:embed 生成的 bin/embed
"""
import json, os, subprocess, math, sys
from collections import defaultdict

HOME = os.path.expanduser('~')
DAY = sys.argv[1] if len(sys.argv) > 1 else '2026-11-16'
LOG = f'{HOME}/.dsh/meeting-memo/asr-log/{DAY}/snippets.jsonl'
LABELS = f'{HOME}/.dsh/meeting-memo/speaker-labels.json'
MODEL = f'{HOME}/.dsh/voice-split/models/3dspeaker_speech_campplus_sv_zh-cn_16k-common.onnx'
EMBED = os.path.expanduser('~/.dsh/meeting-memo/bin/embed')

# 1) 行号 → 片段
rows = []
for i, line in enumerate(open(LOG), start=1):
    line = line.strip()
    if not line: continue
    r = json.loads(line)
    rows.append((i, r))
byline = {i: r for i, r in rows}

# 2) 标签
labels = [l for l in json.load(open(LABELS))['items'] if l['day'] == DAY]
samples = []   # (speaker, line, path)
for lab in labels:
    for ln in lab.get('lines') or []:
        r = byline.get(ln)
        if not r: continue
        path = r.get('audio')
        if not path or not os.path.exists(path): continue
        samples.append((lab['label'], ln, path, r.get('track'), (r.get('text') or '')[:26]))

print(f'带音频的已标注片段: {len(samples)}')
cnt = defaultdict(int)
for s in samples: cnt[s[0]] += 1
print('分布:', dict(cnt))
for s in samples[:4]: print('  ', s[0], '| 行', s[1], '|', s[3], '|', s[4])

# 3) 算声纹
paths = [s[2] for s in samples]
out = subprocess.run([EMBED, MODEL] + paths, capture_output=True, text=True)
vecs = {}
for line in out.stdout.strip().split('\n'):
    if not line: continue
    d = json.loads(line)
    vecs[d['path']] = d['vector']
print(f'拿到声纹: {len(vecs)} / {len(paths)}')

def cos(a, b):
    num = sum(x*y for x, y in zip(a, b))
    na = math.sqrt(sum(x*x for x in a)); nb = math.sqrt(sum(y*y for y in b))
    return num / (na*nb) if na and nb else 0.0

def centroid(vs):
    n = len(vs)
    return [sum(v[i] for v in vs)/n for i in range(len(vs[0]))]

# 4) 留一验证：拿掉自己，用同人其余样本建质心，看最像谁
by_spk = defaultdict(list)
for spk, ln, path, track, text in samples:
    if path in vecs: by_spk[spk].append(vecs[path])

correct = total = 0
same_sims, diff_sims = [], []
detail = []
for spk, ln, path, track, text in samples:
    v = vecs.get(path)
    if not v: continue
    others = {s: [x for x in vs] for s, vs in by_spk.items()}
    if len(others.get(spk, [])) < 2:   # 自己这一类只剩 1 个样本就没法留一
        continue
    others[spk] = others[spk].copy()
    others[spk].remove(v)
    scores = {s: cos(v, centroid(vs)) for s, vs in others.items() if vs}
    best = max(scores, key=scores.get)
    total += 1
    ok = best == spk
    correct += ok
    if ok: same_sims.append(scores[spk])
    for s, sc in scores.items():
        if s != spk: diff_sims.append(sc)
    detail.append((spk, best, round(scores[spk], 3), round(scores.get(best, 0), 3), text))

print(f'\n留一验证: {correct}/{total} 正确' + (f' = {correct/total*100:.0f}%' if total else ''))
for d in detail: print('  ', d)

if same_sims:
    print(f'\n同人相似度: 均值 {sum(same_sims)/len(same_sims):.3f} 最低 {min(same_sims):.3f}')
if diff_sims:
    print(f'异人相似度: 均值 {sum(diff_sims)/len(diff_sims):.3f} 最高 {max(diff_sims):.3f}')
