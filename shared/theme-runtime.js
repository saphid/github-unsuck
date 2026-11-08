// Shared browser/server rules, self-contained for the HTML page's inline script.
export function createThemeTools() {
  const presets = [
    { id: 'dark', family: 'GitHub', name: 'GitHub Dark', appearance: 'dark', colors: ['0d1117','e6edf3','79c0ff','161b22'] },
    { id: 'light', family: 'GitHub', name: 'GitHub Light', appearance: 'light', colors: ['ffffff','1f2328','0969da','f6f8fa'] },
    { id: 'vscode-dark', family: 'Visual Studio Code', name: 'Dark+', appearance: 'dark', colors: ['1e1e1e','d4d4d4','569cd6','252526'] },
    { id: 'vscode-light', family: 'Visual Studio Code', name: 'Light+', appearance: 'light', colors: ['ffffff','333333','005fb8','f3f3f3'] },
    { id: 'catppuccin-mocha', family: 'Catppuccin', name: 'Mocha', appearance: 'dark', colors: ['1e1e2e','cdd6f4','cba6f7','313244'] },
    { id: 'catppuccin-latte', family: 'Catppuccin', name: 'Latte', appearance: 'light', colors: ['eff1f5','4c4f69','8839ef','e6e9ef'] },
    { id: 'dracula', family: 'Dracula', name: 'Dracula', appearance: 'dark', colors: ['282a36','f8f8f2','bd93f9','343746'] },
    { id: 'nord', family: 'Nord', name: 'Nord', appearance: 'dark', colors: ['2e3440','eceff4','88c0d0','3b4252'] },
    { id: 'one-dark-pro', family: 'One Dark Pro', name: 'One Dark Pro', appearance: 'dark', colors: ['282c34','abb2bf','61afef','21252b'] },
    { id: 'solarized-dark', family: 'Solarized', name: 'Solarized Dark', appearance: 'dark', colors: ['002b36','93a1a1','268bd2','073642'] },
    { id: 'solarized-light', family: 'Solarized', name: 'Solarized Light', appearance: 'light', colors: ['fdf6e3','586e75','268bd2','eee8d5'] }
  ];
  const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
  function color(value, base = 'ffffff') {
    if (typeof value !== 'string' || !/^#(?:[\da-f]{3,4}|[\da-f]{6}|[\da-f]{8})$/i.test(value.trim())) return null;
    let hex = value.trim().slice(1);
    if (hex.length < 5) hex = [...hex].map(c => c + c).join('');
    const alpha = hex.length === 8 ? parseInt(hex.slice(6),16) / 255 : 1;
    return [0,2,4].map(i => Math.round(parseInt(hex.slice(i,i+2),16) * alpha + parseInt(base.slice(i,i+2),16) * (1-alpha)).toString(16).padStart(2,'0')).join('');
  }
  function mix(a,b,weight) {
    return [0,2,4].map(i => Math.round(parseInt(a.slice(i,i+2),16)*(1-weight)+parseInt(b.slice(i,i+2),16)*weight).toString(16).padStart(2,'0')).join('');
  }
  function luminance(hex) {
    return [0,2,4].map(i => {const n=parseInt(hex.slice(i,i+2),16)/255;return n<=0.04045?n/12.92:((n+0.055)/1.055)**2.4;}).reduce((sum,n,i)=>sum+n*[0.2126,0.7152,0.0722][i],0);
  }
  function palette(value) {
    if (typeof value !== 'string' || !/^[\da-f]{6}(?:-[\da-f]{6}){3}$/i.test(value)) throw Error('Palette must contain four six-digit hex colors.');
    return value.toLowerCase().split('-');
  }
  function label(value) {
    return typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g,'').trim().slice(0,64) || 'Imported VS Code theme' : 'Imported VS Code theme';
  }
  function resolve(id, packed, name) {
    if (!id) id='dark';
    if (id === 'auto') {
      if(packed != null)throw Error('Only imported themes accept a palette.');
      return { ...presets[0], id: 'auto', name: 'System' };
    }
    if (id === 'custom') {
      const colors=palette(packed);
      return { id, family: 'Imported', name: label(name), colors, appearance: luminance(colors[0]) < 0.179 ? 'dark' : 'light' };
    }
    const preset=presets.find(theme=>theme.id===id);
    if (!preset) throw Error('Choose a supported theme or import a VS Code theme.');
    if (packed != null) throw Error('Only imported themes accept a palette.');
    return preset;
  }
  // Scan comments and trailing commas outside strings; never execute theme code.
  function jsonc(text) {
    if (typeof text !== 'string' || (text.length > 256*1024 || (typeof TextEncoder !== 'undefined' && new TextEncoder().encode(text).length > 256*1024))) throw Error('Theme files must be 256 KB or smaller.');
    let clean='', quoted=false, escaped=false;
    for (let i=0;i<text.length;i++) {
      const c=text[i], next=text[i+1];
      if (quoted) {clean+=c;if(escaped)escaped=false;else if(c==='\\')escaped=true;else if(c==='"')quoted=false;continue;}
      if(c==='"'){quoted=true;clean+=c;continue;}
      if(c==='/'&&next==='/'){for(let j=i;j<text.length;j++){i=j;if(text[j]==='\n')break;}clean+='\n';continue;}
      if(c==='/'&&next==='*'){const end=text.indexOf('*/',i+2);if(end<0)throw Error('Unclosed JSON comment.');clean+=' ';i=end+1;continue;}
      clean+=c;
    }
    let result='';quoted=false;escaped=false;
    for(let i=0;i<clean.length;i++) {
      const c=clean[i];
      if(quoted){result+=c;if(escaped)escaped=false;else if(c==='\\')escaped=true;else if(c==='"')quoted=false;continue;}
      if(c==='"')quoted=true;
      if(c===','){let j=i+1;for(let k=i+1;k<clean.length;k++){j=k;if(!/\s/.test(clean[k]))break;}if(clean[j]==='}'||clean[j]===']')continue;}
      result+=c;
    }
    try{return JSON.parse(result.replace(/^\uFEFF/,''));}catch{throw Error('That is not valid VS Code theme JSON/JSONC.');}
  }
  function importTheme(text) {
    const value=jsonc(text);
    if(!record(value)||!record(value.colors)||!Object.keys(value.colors).some(key=>key.includes('.'))) throw Error('Choose a VS Code color-theme file with workbench colors, not an extension manifest.');
    if(value.include !== undefined)throw Error('This theme uses include inheritance. Merge the included theme colors before importing.');
    const source=value.colors;
    const pick=(base,...keys)=>{for(const key of keys){const parsed=color(source[key],base);if(parsed)return parsed;}return null;};
    const light=value.type==='light'||value.type==='hc-light';
    const base=light?'ffffff':'1e1e1e';
    const bg=pick(base,'editor.background','editorPane.background','sideBar.background');
    if(!bg)throw Error('The theme needs an editor.background or sideBar.background hex color. Merge any inherited colors first.');
    const dark=luminance(bg)<0.179;
    let fg=pick(bg,'editor.foreground','foreground')||(dark?'e6edf3':'1f2328');
    const contrast=(Math.max(luminance(bg),luminance(fg))+0.05)/(Math.min(luminance(bg),luminance(fg))+0.05);
    if(contrast<4.5)fg=dark?'ffffff':'000000';
    const accent=pick(bg,'focusBorder','button.background','textLink.foreground','activityBarBadge.background')||mix(bg,fg,0.72);
    const surface=pick(bg,'sideBar.background','panel.background','editorWidget.background')||mix(bg,fg,0.06);
    return { id:'custom',family:'Imported',name:label(value.displayName||value.name),appearance:dark?'dark':'light',colors:[bg,fg,accent,surface] };
  }
  function parameters(theme) {
    const params=new URLSearchParams({theme:theme.id});
    if(theme.id==='custom'){params.set('palette',palette(theme.colors.join('-')).join('-'));params.set('name',label(theme.name));}
    return params;
  }
  return { presets, color, mix, palette, resolve, importTheme, parameters };
}
