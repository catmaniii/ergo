/** 往网页调网页挂的函数（args 是已经写好的参数表达式）：网页还没挂（还在加载）就不调 */
export function webCallScript(name: string, args: string): string {
  return `(function(){var f=window.${name};return f?f(${args}):undefined})()`;
}
