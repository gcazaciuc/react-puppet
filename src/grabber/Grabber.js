const puppeteer = require('puppeteer');
const _ = require('lodash');
const urlJoin = require('url-join');
const CSSCreator = require('../css-creator');
const { HTMLCreator, Node } = require('../html-creator');

class Grabber {
    constructor() {
        this.client = null;
        this.cssCreator = new CSSCreator();
        this.htmlCreator = new HTMLCreator();
        this.walkDOM = this.walkDOM.bind(this);
        this.createAttributes = this.createAttributes.bind(this);
    }
    async grab(slice) {
        const { url, sel } = slice;
        const browser = await puppeteer.launch({ headless: true });
        const page = await browser.newPage();
        await page.goto(url, { waitUntil: 'networkidle2' });
        this.client = await page.target().createCDPSession();
        this.cssCreator.setClient(this.client);
        this.htmlCreator.setClient(this.client);
        await this.client.send('DOM.enable');
        await this.client.send('CSS.enable');
        await page.waitFor(sel);
        const doc = await this.client.send('DOM.getDocument', { depth: -1 });
        const { nodeId } = await this.client.send('DOM.querySelector', {
            nodeId: doc.root.nodeId,
            selector: sel
        });
        const { node } = await this.client.send('DOM.describeNode', {
            nodeId,
            depth: -1
        });
        await this.walkDOM(node, slice, null);
        await this.client.detach();
        await browser.close();
        return slice;
    }
    async walkDOM(node, sliceConfig, currentDOMNode) {
        if (node.nodeType === 3) {
            // This is a text Node
            const newDOMNode = new Node(node.nodeValue, 'text');
            newDOMNode.parentNode = currentDOMNode;
            currentDOMNode.children.push(newDOMNode);
            return;
        }
        if (
            node.nodeType !== 1 ||
            node.localName.toLowerCase() === 'script' ||
            node.localName.toLowerCase() === 'link'
        ) {
            // It's NOT a text node and it's not a block node
            return;
        }

        const {
            backendNodeId,
            children,
            pseudoType,
            localName: tagName,
            attributes,
            pseudoElements
        } = node;
        const { nodeIds } = await this.client.send('DOM.pushNodesByBackendIdsToFrontend', {
            backendNodeIds: [backendNodeId]
        });
        const [nodeId] = nodeIds;
        const css = await this.cssCreator.getCSS(nodeId);
        const newDOMNode = new Node(tagName, pseudoType ? pseudoType : 'regular');
        newDOMNode.attributes = this.createAttributes(attributes, sliceConfig);
        newDOMNode.css = css;
        newDOMNode.parentNode = currentDOMNode;

        if (currentDOMNode === null) {
            sliceConfig.setMarkup(newDOMNode);
            newDOMNode.id = 'root';
            currentDOMNode = newDOMNode;
        } else {
            currentDOMNode.children.push(newDOMNode);
        }

        // Walk recursively also the children
        if (children && children.length > 0) {
            for (let child of children) {
                await this.walkDOM(child, sliceConfig, newDOMNode);
            }
        }
        // Go into the pseudo elements
        if (pseudoElements && pseudoElements.length > 0) {
            for (let child of pseudoElements) {
                await this.walkDOM(child, sliceConfig, newDOMNode);
            }
        }
    }
    convert(baseUrl, currentUrl) {
        if (
            !currentUrl ||
            /^(https?|file|ftps?|mailto|javascript|data:image\/[^;]{2,9};):/i.test(currentUrl)
        ) {
            return currentUrl;
        }
        return urlJoin(baseUrl, currentUrl);
    }
    createAttributes(attributes, sliceConfig) {
        const transformedAttributes = {};
        for (let i = 0; i < attributes.length; i += 2) {
            let attrName = attributes[i];
            let attrVal = `'${attributes[i + 1]}'`;
            if (attrName === 'src' || attrName === 'href') {
                attrVal = attrVal.replace(/['"]/gim, '');
                attrVal = `'${this.convert(sliceConfig.url, attrVal)}'`;
            }
            const shouldRemove =
                attrName.indexOf('data-') === 0 && sliceConfig.removeDataAttributes;
            if (!shouldRemove) {
                transformedAttributes[attrName] = attrVal;
            }
        }
        return transformedAttributes;
    }
}
module.exports = Grabber;
