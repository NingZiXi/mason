"""Original 28-second restrained plucked score, deterministic and reproducible."""
import json,wave
from pathlib import Path
import numpy as np
root=Path(__file__).resolve().parent
plan=json.loads((root/'plan.json').read_text(encoding='utf-8'))
sr=48000;duration=plan['duration'];music=np.zeros((int(sr*duration),2));rng=np.random.default_rng(19347)
def put(start,notes,length=1.2,gain=.08,pan=0):
    t=np.arange(int(length*sr))/sr
    for midi in notes:
        f=440*2**((midi-69)/12)
        tone=(np.sin(2*np.pi*f*t)+.22*np.sin(2*np.pi*f*2*t)+.08*np.sin(2*np.pi*f*3*t))*np.exp(-t*3.2)*np.minimum(t/.012,1)
        tone*=gain
        at=int(start*sr);n=min(len(tone),len(music)-at)
        if n<=0:continue
        music[at:at+n,0]+=tone[:n]*np.sqrt((1-pan)/2)
        music[at:at+n,1]+=tone[:n]*np.sqrt((1+pan)/2)
        delay=int(.21*sr)
        n2=min(n,len(music)-at-delay)
        if n2>0:music[at+delay:at+delay+n2]+=tone[:n2,None]*.14
chords=[[50,57,66],[47,54,62],[43,50,59],[45,52,61]]
for k,at in enumerate(np.arange(0,25.2,.6)):
    chord=chords[(k//8)%4]
    put(float(at),[chord[k%3]+12],gain=.09 if k%4 else .12,pan=(-.28 if k%2 else .28))
    if k%4==0:put(float(at),chord[:1],length=2.2,gain=.09)
    if 14<=at<23 and k%2==0:
        t=np.arange(int(.09*sr))/sr
        tap=rng.normal(0,1,len(t))*.012*np.exp(-t*65)*np.minimum(t/.003,1)
        p=int(at*sr);music[p:p+len(t)]+=tap[:,None]
put(25.2,[50,57,62,66,69],length=2.8,gain=.085)
fade=np.minimum(np.arange(len(music))/sr/.15,1)*np.minimum((len(music)-np.arange(len(music)))/sr/.9,1)
music*=fade[:,None]
with wave.open(str(root/'assets/music.wav'),'wb') as f:
    f.setnchannels(2);f.setsampwidth(2);f.setframerate(sr);f.writeframes((np.clip(music,-1,1)*32767).astype('<i2').tobytes())
print('Original music peak',float(np.max(np.abs(music))))
