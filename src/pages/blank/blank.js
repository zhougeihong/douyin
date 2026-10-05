import Blank from './blank.vue';

class PageBlank extends $falcon.Page {
  onLoad(options) {
    super.onLoad(options);
    this.setRootComponent(Blank);
  }
}

export default PageBlank;
