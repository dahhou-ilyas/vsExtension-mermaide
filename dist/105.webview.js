"use strict";(self.webpackChunkflowchartgenerator=self.webpackChunkflowchartgenerator||[]).push([[105],{7105:(t,e,r)=>{r.r(e),r.d(e,{default:()=>p});var n=r(6540),o=r(5698);function i(t){return i="function"==typeof Symbol&&"symbol"==typeof Symbol.iterator?function(t){return typeof t}:function(t){return t&&"function"==typeof Symbol&&t.constructor===Symbol&&t!==Symbol.prototype?"symbol":typeof t},i(t)}function u(t,e){for(var r=0;r<e.length;r++){var n=e[r];n.enumerable=n.enumerable||!1,n.configurable=!0,"value"in n&&(n.writable=!0),Object.defineProperty(t,c(n.key),n)}}function c(t){var e=function(t){if("object"!=i(t)||!t)return t;var e=t[Symbol.toPrimitive];if(void 0!==e){var r=e.call(t,"string");if("object"!=i(r))return r;throw new TypeError("@@toPrimitive must return a primitive value.")}return String(t)}(t);return"symbol"==i(e)?e:e+""}function f(){try{var t=!Boolean.prototype.valueOf.call(Reflect.construct(Boolean,[],(function(){})))}catch(t){}return(f=function(){return!!t})()}function a(t){return a=Object.setPrototypeOf?Object.getPrototypeOf.bind():function(t){return t.__proto__||Object.getPrototypeOf(t)},a(t)}function l(t,e){return l=Object.setPrototypeOf?Object.setPrototypeOf.bind():function(t,e){return t.__proto__=e,t},l(t,e)}const p=function(t){function e(){return function(t,e){if(!(t instanceof e))throw new TypeError("Cannot call a class as a function")}(this,e),function(t,e,r){return e=a(e),function(t,e){if(e&&("object"==i(e)||"function"==typeof e))return e;if(void 0!==e)throw new TypeError("Derived constructors may only return object or undefined");return function(t){if(void 0===t)throw new ReferenceError("this hasn't been initialised - super() hasn't been called");return t}(t)}(t,f()?Reflect.construct(e,r||[],a(t).constructor):e.apply(t,r))}(this,e,arguments)}return function(t,e){if("function"!=typeof e&&null!==e)throw new TypeError("Super expression must either be null or a function");t.prototype=Object.create(e&&e.prototype,{constructor:{value:t,writable:!0,configurable:!0}}),Object.defineProperty(t,"prototype",{writable:!1}),e&&l(t,e)}(e,t),r=e,(c=[{key:"componentDidMount",value:function(){o.A.initialize({startOnLoad:!0,securityLevel:"loose",theme:"default",themeCSS:"\n        g.classGroup rect {\n          fill: #282a36;\n          stroke: #6272a4;\n        }\n        g.classGroup text {\n          fill: #f8f8f2;\n        }\n        /* Personnalisation supplémentaire */\n      ",fontFamily:"Fira Code"}),o.A.contentLoaded()}},{key:"render",value:function(){return n.createElement("div",{className:"mermaid"},this.props.chart)}}])&&u(r.prototype,c),Object.defineProperty(r,"prototype",{writable:!1}),r;var r,c}(n.Component)}}]);