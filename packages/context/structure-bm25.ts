import type { StructureCorpus, StructureSource } from './structure-corpus.ts';

export function structureTokens(text:string):string[]{return text.toLowerCase().split(/\s+/u).filter(Boolean).flatMap(word=>{const chars=[...word];return [word,...chars.slice(0,-1).map((c,i)=>c+chars[i+1])];});}
export class StructureBM25 {
 readonly N:number;
 readonly avgDL:number;
 readonly DF=new Map<string,number>();
 private readonly docs;
 constructor(docs:readonly {id:string;text:string}[]){
  this.docs=docs.map(doc=>{const tokens=structureTokens(doc.text),tf=new Map<string,number>();for(const t of tokens)tf.set(t,(tf.get(t)??0)+1);for(const t of tf.keys())this.DF.set(t,(this.DF.get(t)??0)+1);return {id:doc.id,length:tokens.length,tf};});
  this.N=docs.length;this.avgDL=this.docs.reduce((sum,d)=>sum+d.length,0)/(this.N||1);
 }
 rank(query:string):string[]{return this.scored(query).map(d=>d.id);}
 /** coverage = matched share of the query's IDF mass; unseen query terms count against coverage. */
 scored(query:string):{id:string;score:number;coverage:number}[]{
  const terms=[...new Set(structureTokens(query))],idf=(t:string)=>{const df=this.DF.get(t)??0;return Math.log(1+(this.N-df+.5)/(df+.5));};
  const mass=terms.reduce((sum,t)=>sum+idf(t),0);
  return this.docs.map((d,i)=>{let score=0,matched=0;for(const t of terms){const tf=d.tf.get(t)??0;if(!tf)continue;matched+=idf(t);score+=idf(t)*tf*2.2/(tf+1.2*(.25+.75*d.length/(this.avgDL||1)));}return {id:d.id,i,score,coverage:mass?matched/mass:0};})
   .sort((a,b)=>b.score-a.score||b.i-a.i).map(({id,score,coverage})=>({id,score,coverage}));
 }
}
export type StructureFillFloor={readonly coverage:number;readonly ratio:number;readonly recent?:number};
export function relevantFill(scored:readonly {id:string;score:number;coverage:number}[],floor:StructureFillFloor|undefined):string[]{
 if(!floor)return scored.map(s=>s.id);
 const top=scored[0]?.score??0;
 return scored.filter(s=>s.score>0&&s.coverage>=floor.coverage&&s.score>=top*floor.ratio).map(s=>s.id);
}
export function substantive(source:StructureSource):boolean {
 if(source.kind==='progress'||!source.content.trim())return false;
 const text=source.content.trim();if(source.kind==='user'||text.length>=350)return true;
 return !(/(?:확인|찾|살펴|계산|진행|정리|알려|보내|조사|예약|등록|취소|보고|비교|추가|수정|변경|확보|되돌려|시도|접속|검색|만들|말씀드)[\s\S]*(?:할게요|하겠습니다|볼게요|드릴게요|겠습니다|둘게요)[.!。]?\s*$/.test(text)||/^(?:네[.!]?|알겠습니다[.!]?|좋아요[.!]?|👍.*)$/u.test(text)||/^(?:I(?:'ll| will)|Let me)\s[^\n]*(?:check|look|search|investigate|review|work on)[^\n]*[.!]?$/iu.test(text));
}
export function priorSources(corpus:StructureCorpus){return corpus.sources.filter(s=>s.sequence<corpus.child.sequence&&Date.parse(s.created_at)<=Date.parse(corpus.current.created_at)&&substantive(s));}
// A single bounded cache, replaced on every revalidated snapshot version. No stale retained text is reused.
export class StructureCorpusCache {
 private entry:{key:string;index:StructureBM25}|undefined;
 index(corpus:StructureCorpus){const key=JSON.stringify([corpus.workspace_id,corpus.conversation_id,corpus.version,corpus.child.sequence]);if(this.entry?.key===key)return this.entry.index;
  const sources=priorSources(corpus),docs=corpus.exchanges.filter(e=>e.sequence<corpus.child.sequence).toSorted((a,b)=>a.sequence-b.sequence).map(e=>({id:e.id,text:sources.filter(s=>s.exchange_id===e.id).map(s=>s.content).join('\n')}));
  const index=new StructureBM25(docs);this.entry={key,index};return index;
 }
}
