import json,sys,re
root,strings=sys.argv[1],sys.argv[2]
p=root+'/media/dashboard/fixtures.js'
s=open(p,encoding='utf-8').read()
table=json.load(open(strings,encoding='utf-8'))
lines=[]
for k,v in table.items():
    # ASCII-only output: JSON escapes every non-ASCII character
    lines.append('    %s: %s,' % (k, json.dumps(v, ensure_ascii=True)))
block='/* <strings:begin> */\n  const STRINGS = {\n'+'\n'.join(lines)+'\n  };\n  /* <strings:end> */'
a=s.index('/* <strings:begin> */'); b=s.index('/* <strings:end> */')+len('/* <strings:end> */')
s=s[:a]+block+s[b:]
open(p,'w',encoding='utf-8').write(s)
print('filled',len(table))
