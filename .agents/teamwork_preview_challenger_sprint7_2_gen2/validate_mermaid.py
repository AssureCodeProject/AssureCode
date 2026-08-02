import re
import subprocess
import os

with open(r'C:\Users\hp\AssureCode\architecture_overview.md', 'r', encoding='utf-8') as f:
    content = f.read()

mermaid_blocks = re.findall(r'```mermaid\n(.*?)\n```', content, re.DOTALL)
print(f"Found {len(mermaid_blocks)} mermaid blocks.")

work_dir = r'C:\Users\hp\AssureCode\.agents\teamwork_preview_challenger_sprint7_2_gen2'

results = []
for idx, block in enumerate(mermaid_blocks, 1):
    mmd_path = os.path.join(work_dir, f'diagram_{idx}.mmd')
    svg_path = os.path.join(work_dir, f'diagram_{idx}.svg')
    with open(mmd_path, 'w', encoding='utf-8') as f:
        f.write(block)
    
    print(f"\n--- Validating Diagram {idx} ---")
    cmd = f'npx --yes @mermaid-js/mermaid-cli -i "{mmd_path}" -o "{svg_path}"'
    proc = subprocess.run(cmd, shell=True, capture_output=True, text=True)
    if proc.returncode == 0:
        print(f"Diagram {idx} VALIDATED successfully!")
        results.append((idx, True, proc.stdout))
    else:
        print(f"Diagram {idx} FAILED validation!")
        print("STDERR:\n", proc.stderr)
        results.append((idx, False, proc.stderr))

with open(os.path.join(work_dir, 'mermaid_validation_result.txt'), 'w', encoding='utf-8') as f:
    for idx, passed, msg in results:
        f.write(f"Diagram {idx}: {'PASS' if passed else 'FAIL'}\n{msg}\n\n")
