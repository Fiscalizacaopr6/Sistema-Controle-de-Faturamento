# Gera os formulários de Reembolso Creche por contrato a partir de Reembolso_Creche.html
import io,json,os,sys
REPO=r"C:\Users\ismae\Downloads\repo-temp"
DADOS=r"C:\Users\ismae\AppData\Local\Temp\claude\C--Program-Files-Git-bin\3734d0aa-a123-4a91-8e60-6a154aea1a76\scratchpad\dados.json"
D=json.load(io.open(DADOS,encoding='utf-8'))
def emp(c):
    for r in D:
        if r and r.get('CONTRATO')==c: return r.get('EMPRESA','')
    sys.exit('empresa nao encontrada: '+c)
base=io.open(os.path.join(REPO,'Reembolso_Creche.html'),encoding='utf-8').read()
OLD_DB="""  contrato:'', empresa:'',
  startMonth:0, startYear:(new Date()).getFullYear(),
  locked:false,
  creche:{}   // creche[period] = {retido, aprov, val}"""
OLD_GR="var GRUPOS = [{sfx:'', nome:''}];"
assert OLD_DB in base and OLD_GR in base
MES=['JAN','FEV','MAR','ABR','MAI','JUN','JUL','AGO','SET','OUT','NOV','DEZ']
def gen(contrato, arq, mes, ano, grupos):
    per=MES[mes]+'-'+str(ano)[-2:]
    campos=[]; gdef=[]
    for i,(nome,unit,ret) in enumerate(grupos):
        sfx='' if i==0 else str(i+1)
        campos.append("retido%s:%s, aprov%s:0, val%s:%s"%(sfx,repr(ret),sfx,sfx,repr(unit)))
        gdef.append("{sfx:'%s', nome:'%s'}"%(sfx,nome))
    novo=("  contrato:'%s', empresa:'%s',\n"
          "  startMonth:%d, startYear:%d,\n"
          "  locked:false,\n"
          "  creche:{'%s':{%s}}   // creche[period] = {retido, aprov, val} (por grupo)"
          )%(contrato, emp(contrato).replace("'","\'"), mes, ano, per, ", ".join(campos))
    s=base.replace(OLD_DB,novo)
    s=s.replace(OLD_GR,"var GRUPOS = ["+", ".join(gdef)+"];")
    s=s.replace("var STORAGE_KEY = 'reembolso_creche';","var STORAGE_KEY = 'reembolso_creche_%s';"%contrato.replace('/','_'))
    s=s.replace("<title>Reembolso Creche</title>","<title>Reembolso Creche %s</title>"%contrato)
    io.open(os.path.join(REPO,arq),'w',encoding='utf-8',newline='').write(s)
    print("ok:",arq)
gen("11/25","Reembolso Creche - 11-25 - Atlantica.html",7,2026,[("",120.04,9363.12)])
gen("34/25","Reembolso Creche - 34-25 - Atlantica Macae.html",7,2026,[("",121.23,4485.46)])
gen("62/22","Reembolso Creche - 62-22 - Plansul.html",7,2026,[("",116.93,3741.76)])
gen("44/25","Reembolso Creche - 44-25 - Edil.html",8,2026,[("",135.87,1902.17)])
gen("44/24","Reembolso Creche - 44-24 - CS Carvalho.html",8,2026,[("",121.69,1825.35)])
gen("27/22","Reembolso Creche - 27-22 - Manage.html",8,2026,[("",120.55,120.55)])
gen("60/22","Reembolso Creche - 60-22 - Rodocon.html",8,2026,[("",122.33,122.33)])
gen("05/26","Reembolso Creche - 05-26 - Eletrodata.html",7,2026,
    [("LOTE 1 — 13 postos",142.92,1857.96),("LOTE 2 — 23 postos",142.57,3279.11)])
gen("97/22","Reembolso Creche - 97-22 - Lince.html",7,2026,
    [("ENCARREGADO — 1 posto",130.21,130.21),("SERVENTES — 46 postos (itens 1 e 2)",121.00,5566.05)])
