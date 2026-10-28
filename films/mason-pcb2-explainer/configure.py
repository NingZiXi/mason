import json,shutil,sys
from pathlib import Path
root=Path(__file__).resolve().parent
skill=Path(r'C:/Users/Hszn/.agents/skills/guizang-product-video-skill')
sys.path.insert(0,str(skill/'scripts'))
from sfx_landmarks import landmarks
specs=[('intro',0,4,'一块板子，两种做法','One board. Two ways.','用 PCB2 真实示例，讲清从 Gerber 到打印模型。',False,[]),('parse',4,9,'读懂板框，也读懂焊盘','Read the geometry','85 × 60 mm · 顶层 347 个解析焊盘',True,['repo:src/lib/gerber/parser.ts','repo:src/lib/gerber/pads.ts']),('modes',9,14,'为不同需求，生成不同工具','Choose your tool','金属钢网夹具 / 一体式打印钢网',True,['repo:python/jig_generator.py']),('assembly',14,23,'先夹紧，再定位','Clamp. Then locate.','A 面顶盖 + 金属钢网 + B 面底座 → PCB 托盘',True,['repo:python/jig_generator.py']),('export',23,28,'从文件，到能打印的模型','Ready for your next build','导出 STL / STEP · 下载同款 Gerber 示例',True,['repo:src/components/ModelPreview.vue'])]
shots=[dict(id=i,start=s,end=e,type='detail',headline=h,headlineEn=en,description=d,descriptionAt=0,plainExplanation=d,claim=c,source=src,component='src/client.jsx',actions=[]) for i,s,e,h,en,d,c,src in specs]
cues=[]
for aid,time,name in [('parse-lock',6.3,'pop'),('mode-switch',9.1,'toggle'),('clamp',18.4,'click'),('seat',21.4,'resolve'),('export-ready',23.5,'success')]:
    file=root/'assets'/'sfx'/(name+'.wav');file.parent.mkdir(exist_ok=True)
    shutil.copy2(skill/'assets'/'audio'/'sfx'/(name+'.wav'),file)
    lm=landmarks(file);offset=lm['onset']
    shot=next(s for s in shots if s['start']<=time<s['end'])
    shot['actions'].append(dict(id=aid,at=round(time-shot['start'],3),action=aid,soundRequired=True))
    cues.append(dict(at=round(time-offset,3),syncOffset=offset,actionId=aid,file='assets/sfx/'+name+'.wav',gain=1.8,role='sfx',kind=name))
shutil.copy2(skill/'assets/audio/sfx/SOURCE.txt',root/'assets/sfx/SOURCE.txt')
plan=dict(demo=False,product='Mason · PCB2 结构讲解',style='repo',repo=str(root.parents[1]),width=1920,height=1080,fps=30,duration=28,scope=dict(versions='current working tree',platforms=['desktop']),typography=dict(mode='bilingual',zhFont='Microsoft YaHei',enFont='Segoe UI',zhStyle='sans-serif'),audioRequired=True,sfxRequired=True,audio=dict(music=dict(file='assets/music.wav',gain=.7),ducking=dict(enabled=True),cues=cues),shots=shots)
(root/'plan.json').write_text(json.dumps(plan,ensure_ascii=False,indent=2),encoding='utf-8')
(root/'BRIEF.md').write_text('# PCB2 官网讲解动效\n\n28 秒 / 1080p / 30fps / 中文字幕与短英文标题。当前桌面功能介绍，非版本发布片。用户指定真实 PCB2 Gerber 示例；风格沿用产品配色。用于官网，交付 MP4、海报、字幕、可复现工程与可导入 Gerber 示例。',encoding='utf-8')
(root/'evidence/audio-selection.json').write_text(json.dumps(dict(music=dict(source='code-original',script='score.py',bpm=100,key='D major',duration=28),sfx=[dict(file=c['file'],source='guizang-product-video-skill original SFX',license='see assets/sfx/SOURCE.txt',reason='No user-provided or configured local recorded SFX library was available') for c in cues]),indent=2),encoding='utf-8')
print('Configured',len(shots),'shots and',len(cues),'measured audio cues')
