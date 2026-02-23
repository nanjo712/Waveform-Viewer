# Waveform Viewer

[English](README.md) | **中文**

## 插件开发指南

> [!NOTE]
> **我可以用 WASM 或原生 C++ 编写插件吗？**
> 目前，波形查看器的核心解析器是用 C++ 编写并编译为 WebAssembly (WASM) 以获得高性能。然而，**所有的格式化插件必须用 JavaScript 或 TypeScript 编写**。插件系统依赖于浏览器的 JavaScript 引擎来执行 `format` 函数，并将它们动态注入到 React 前端。如果您有计算繁重的格式化逻辑，您在技术上可以将其编译为单独的 WASM 模块并从您的 JavaScript 插件包装器中调用它，但插件接口本身必须保持为 JS/TS。

本文档说明了如何为 Waveform Viewer（波形查看器）编写和注册自定义信号格式化插件。

#### 概述

波形查看器支持自定义格式化程序，以不同的方式（例如，十六进制、浮点数、ASCII 等）显示信号值。一个插件可以定义多个“视图”（格式化器），每个视图支持特定的信号位宽或任意位宽。

#### 插件接口

插件基于 `frontend/src/types/plugin.ts` 中定义的两个主要的 TypeScript 接口：

```typescript
export interface FormatView {
    id: string;                                    // 视图的唯一标识符
    name: string;                                  // 在 UI 中显示的名称
    supportedWidths: number[] | 'any';             // 支持的信号位宽（例如 [16, 32] 或 'any'表示任意）
    format: (val: string, width: number) => {      // 格式化函数
        display: string;                           // 要显示的格式化字符串
        isX: boolean;                              // 值是否包含未定义位 'x' 或 'X'
        isZ: boolean;                              // 值是否包含高阻态位 'z' 或 'Z'
    };
}

export interface FormatPlugin {
    id: string;            // 插件的唯一标识符
    name: string;          // 插件包名称（例如 'IEEE 754 Float Formatter'）
    views: FormatView[];   // 此插件提供的格式化视图数组
}
```

#### `format` 函数

插件的核心是 `format` 函数。它接收：
- `val`: 包含信号的原始二进制表示的 `string`（例如 `"1010"`、`"x"`、`"z"`）。它可能包含前导二进制指示符如 `b`，但建议去除或小心处理它们。
- `width`: 指示信号位宽的 `number`。

它必须返回一个具有以下属性的对象：
- `display`: 要在波形和信号列表中呈现的最终字符串。
- `isX`: 如果值为未定义 (X)，则为 true。
- `isZ`: 如果值为高阻态 (Z)，则为 true。

#### 示例：一个自定义布尔值插件

下面是一个简单的插件示例，可将 1 位信号格式化为 `True` 或 `False`。

**TypeScript:**
```typescript
import type { FormatPlugin } from './types/plugin';

export const myBooleanPlugin: FormatPlugin = {
    id: 'my_boolean',
    name: '布尔值格式化',
    views: [
        {
            id: 'Bool',
            name: 'True/False',
            supportedWidths: [1], // 仅支持 1 位信号
            format: (val: string, width: number) => {
                // 处理 X 和 Z 状态
                const isX = val.toLowerCase().includes('x');
                const isZ = val.toLowerCase().includes('z');
                
                if (isX) return { display: 'X', isX, isZ };
                if (isZ) return { display: 'Z', isX, isZ };

                // 解析二进制值
                const cleanVal = val.replace(/^[bB]/, ''); // 如果有 'b' 前缀则移除
                const boolValue = parseInt(cleanVal, 2) === 1;

                return {
                    display: boolValue ? 'True' : 'False',
                    isX: false,
                    isZ: false
                };
            }
        }
    ]
};
```

**JavaScript:**
```javascript
const myBooleanPlugin = {
    id: 'my_boolean',
    name: '布尔值格式化',
    views: [
        {
            id: 'Bool',
            name: 'True/False',
            supportedWidths: [1],
            format: (val, width) => {
                const isX = val.toLowerCase().includes('x');
                const isZ = val.toLowerCase().includes('z');
                
                if (isX) return { display: 'X', isX, isZ };
                if (isZ) return { display: 'Z', isX, isZ };

                const cleanVal = val.replace(/^[bB]/, '');
                const boolValue = parseInt(cleanVal, 2) === 1;

                return {
                    display: boolValue ? 'True' : 'False',
                    isX: false,
                    isZ: false
                };
            }
        }
    ]
};
```

#### 注册您的插件

可以通过两种方式注册插件：

##### 1. 内置核心插件
如果您正在将内置插件直接添加到仓库：
1. 将您的插件文件放在 `frontend/src/plugins/` 目录中。
2. 在 `frontend/src/hooks/useAppContext.tsx` 中导入它。
3. 将其添加到 `useAppContext.tsx` 中 `initialState` 的 `formatPlugins` 数组。

##### 2. 动态注册（在运行时）
对于在运行时加载的外部插件，应用程序在 `window` 对象上暴漏了全局注册方法：

```javascript
window.WaveformViewer.registerPlugin(myBooleanPlugin);
```

调用此方法时，插件会被派发到应用程序状态中，并在 UI 中立即可供用户选择以匹配相应的信号。

#### 处理基数前缀和对齐
传递给 `format` 函数的信号可能需要解析。由核心插件经常使用的一种实用程序模式是去除二进制前缀，并将字符串填充为正确的位宽：

```typescript
function parseBase(val: string, width: number) {
    let raw = val;
    if (raw.startsWith('b') || raw.startsWith('B')) raw = raw.slice(1);

    const isX = raw.includes('x') || raw.includes('X');
    const isZ = raw.includes('z') || raw.includes('Z');

    const paddedBin = raw.padStart(width, '0');
    return { isX, isZ, paddedBin };
}
```
使用这种模式确保对 'X'/'Z' 状态的统一处理，以及为算术转换正确对齐。
