export default function ExistingResourceFrame() {
 const [source,setSource]=useState<any>(null),[error,setError]=useState('');
 useEffect(()=>{let live=true;(async()=>{try{const entry=await readFile('./resources.json');if(!entry)throw new Error('Resource source is unavailable.');const data=JSON.parse(await entry.file.text());if(live)setSource(data);}catch(e:any){if(live)setError(e?.message||'Resource source is unavailable.');}})();return()=>{live=false;};},[]);
 return <main data-eval="planner-root" style={{fontFamily:'sans-serif',maxWidth:1100,margin:'auto',padding:20}}><h1>Resource planning</h1>{error?<p role="alert">{error}</p>:source?<ResourceView source={source}/>:<p role="status">Loading resources</p>}</main>;
}
