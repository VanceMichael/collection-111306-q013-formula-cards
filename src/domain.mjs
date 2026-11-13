export function formulaIdentity(card,local){if(!card||!local)throw new Error('公式缺少卡片作用域');return JSON.stringify([card,local]);}
export function preview(data){return {generation:data.generation,mode:'text-preview'};}
