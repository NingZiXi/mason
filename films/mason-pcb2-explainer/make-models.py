import sys,json,time
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[2]/'python'))
import jig_generator as jig
root=Path(__file__).resolve().parent
out=root/'public'/'models';out.mkdir(exist_ok=True)
for name in ['insert','base','cover','stencil_top']:
    params=json.loads((root/('params-stencil.json' if name=='stencil_top' else 'params-jig.json')).read_text())
    t=time.time()
    jig.generate_to_file(params,name,out/(name+'.stl'))
    print(name,round(time.time()-t,2),flush=True)
p=json.loads((root/'params-jig.json').read_text())
slot,platter,window,shaped=jig.get_polys(p)
(root/'public'/'mechanics.json').write_text(json.dumps({'posts':jig.corner_screw_positions(window,p['jig_size'],p),'screws':jig.compute_perimeter_screw_positions(p['jig_size'],window,p['screw_spacing']),'plateHeight':p['insert_height']-p['base_height']}))
