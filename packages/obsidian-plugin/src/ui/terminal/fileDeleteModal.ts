import {Modal,type App} from 'obsidian';
import {t} from '../../i18n';
export class FileDeleteModal extends Modal {
  private resolve: ((confirmed:boolean)=>void)|null=null;
  constructor(app:App,private path:string,private type:string){super(app);}
  static confirm(app:App,path:string,type:string):Promise<boolean>{return new Promise(resolve=>{const modal=new FileDeleteModal(app,path,type);modal.resolve=resolve;modal.open();});}
  onOpen():void{
    this.titleEl.setText(t('release21.deleteTitle'));
    this.contentEl.createEl('p',{text:this.path});
    this.contentEl.createEl('p',{text:t('release21.deleteType',{type:this.type})});
    this.contentEl.createEl('p',{text:t('release21.deleteHint')});
    const actions=this.contentEl.createDiv('modal-button-container');
    actions.createEl('button',{text:t('common.cancel')}).addEventListener('click',()=>this.close());
    actions.createEl('button',{text:t('common.delete'),cls:'mod-warning'}).addEventListener('click',()=>{this.resolve?.(true);this.resolve=null;this.close();});
  }
  onClose():void{this.resolve?.(false);this.resolve=null;this.contentEl.empty();}
}
