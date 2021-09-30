// TODO
// 1. shadow
// 2. Image: sx, sy, sw, sh

import {
    adjustTextY,
    getIdURL,
    getMatrixStr,
    getShadowKey,
    hasShadow,
    isAroundZero,
    isGradient,
    isImagePattern,
    isLinearGradient,
    isPattern,
    isRadialGradient,
    normalizeColor,
    round4,
    TEXT_ALIGN_TO_ANCHOR
} from './helper';
import Path, { PathStyleProps } from '../graphic/Path';
import ZRImage, { ImageStyleProps } from '../graphic/Image';
import { DEFAULT_FONT, getLineHeight } from '../contain/text';
import TSpan, { TSpanStyleProps } from '../graphic/TSpan';
import SVGPathRebuilder from './SVGPathRebuilder';
import mapStyleToAttrs from './mapStyleToAttrs';
import { SVGVNodeAttrs, createVNode, SVGVNode, vNodeToString } from './core';
import { MatrixArray } from '../core/matrix';
import Displayable from '../graphic/Displayable';
import { assert, logError, map, retrieve2 } from '../core/util';
import Polyline from '../graphic/shape/Polyline';
import Polygon from '../graphic/shape/Polygon';
import { GradientObject } from '../graphic/Gradient';
import { ImagePatternObject, SVGPatternObject } from '../graphic/Pattern';
import { createAnimates, hasShapeAnimation } from './animation';
import { createOrUpdateImage } from '../graphic/helper/image';
import { ImageLike } from '../core/types';

export interface BrushScope {
    shadowCache: Record<string, string>
    gradientCache: Record<string, string>
    patternCache: Record<string, string>
    clipPathCache: Record<string, string>
    defs: Record<string, SVGVNode>

    shadowIdx: number,
    gradientIdx: number,
    patternIdx: number,
    clipPathIdx: number
    // configs
    /**
     * If create animates nodes.
     */
    animation?: boolean,

    /**
     * If will update. Some optimization for string generation can't be applied.
     */
    willUpdate?: boolean
}


type AllStyleOption = PathStyleProps | TSpanStyleProps | ImageStyleProps;

function setStyleAttrs(attrs: SVGVNodeAttrs, style: AllStyleOption, el: Path | TSpan | ZRImage, scope: BrushScope) {
    mapStyleToAttrs((key, val) => {
        const isFillStroke = key === 'fill' || key === 'stroke';
        if (isFillStroke && isGradient(val)) {
            setGradient(style, attrs, key, scope);
        }
        else if (isFillStroke && isPattern(val)) {
            setPattern(el, attrs, key, scope);
        }
        else {
            attrs[key] = val;
        }
    }, style, el, false);

    setShadow(el, attrs, scope);
}

function noRotateScale(m: MatrixArray) {
    return isAroundZero(m[0] - 1)
        && isAroundZero(m[1])
        && isAroundZero(m[2])
        && isAroundZero(m[3] - 1);
}

function noTranslate(m: MatrixArray) {
    return isAroundZero(m[4]) && isAroundZero(m[5]);
}

function setTransform(attrs: SVGVNodeAttrs, m: MatrixArray) {
    if (m && !(noTranslate(m) && noRotateScale(m))) {
        // Use translate possible to reduce the size a bit.
        attrs.transform = noRotateScale(m)
            ? `translate(${round4(m[4])} ${round4(m[5])})` : getMatrixStr(m);
    }
}

type ShapeMapDesc = (string | [string, string])[];
type ConvertShapeToAttr = (shape: any, attrs: SVGVNodeAttrs) => void;
type ShapeValidator = (shape: any) => boolean;

function convertPolyShape(shape: Polygon['shape'], attrs: SVGVNodeAttrs) {
    const points = shape.points;
    const strArr = [];
    for (let i = 0; i < points.length; i++) {
        strArr.push(round4(points[i][0]));
        strArr.push(round4(points[i][1]));
    }
    attrs.points = strArr.join(' ');
}

function validatePolyShape(shape: Polyline['shape']) {
    return !shape.smooth;
}

function createAttrsConvert(desc: ShapeMapDesc): ConvertShapeToAttr {
    const normalizedDesc: [string, string][] = map(desc, (item) =>
        (typeof item === 'string' ? [item, item] : item)
    );

    return function (shape, attrs) {
        for (let i = 0; i < normalizedDesc.length; i++) {
            const item = normalizedDesc[i];
            const val = shape[item[0]];
            if (val != null) {
                attrs[item[1]] = round4(val);
            }
        }
    };
}

const buitinShapesDef: Record<string, [ConvertShapeToAttr, ShapeValidator?]> = {
    circle: [createAttrsConvert(['cx', 'cy', 'r'])],
    polyline: [convertPolyShape, validatePolyShape],
    polygon: [convertPolyShape, validatePolyShape]
    // Ignore line because it will be larger.
};

interface PathWithSVGBuildPath extends Path {
    __svgPathVersion: number
    __svgPathBuilder: SVGPathRebuilder
}

export function brushSVGPath(el: Path, scope: BrushScope) {
    const style = el.style;
    const shape = el.shape;
    const builtinShpDef = buitinShapesDef[el.type];
    const attrs: SVGVNodeAttrs = {};
    const needsAnimate = scope.animation;
    let svgElType = 'path';
    const strokePercent = el.style.strokePercent;
    // Using SVG builtin shapes if possible
    if (builtinShpDef
        // Force to use path if it will update later.
        // To avoid some animation(like morph) fail
        && !scope.willUpdate
        && !(builtinShpDef[1] && !builtinShpDef[1](shape))
        // use `path` to simplify the animate element creation logic.
        && !(needsAnimate && hasShapeAnimation(el))
        && !(strokePercent < 1)
    ) {
        svgElType = el.type;
        builtinShpDef[0](shape, attrs);
    }
    else {
        if (!el.path) {
            el.createPathProxy();
        }
        const path = el.path;

        if (el.shapeChanged()) {
            path.beginPath();
            el.buildPath(path, el.shape);
            el.pathUpdated();
        }
        const pathVersion = path.getVersion();
        const elExt = el as PathWithSVGBuildPath;

        let svgPathBuilder = elExt.__svgPathBuilder;
        if (elExt.__svgPathVersion !== pathVersion || !svgPathBuilder || strokePercent < 1) {
            if (!svgPathBuilder) {
                svgPathBuilder = elExt.__svgPathBuilder = new SVGPathRebuilder();
            }
            svgPathBuilder.reset();
            path.rebuildPath(svgPathBuilder, strokePercent);
            svgPathBuilder.generateStr();
            elExt.__svgPathVersion = pathVersion;
        }

        attrs.d = svgPathBuilder.getStr();
    }

    setTransform(attrs, el.transform);
    setStyleAttrs(attrs, style, el, scope);

    return createVNode(svgElType, el.id + '', attrs, needsAnimate && createAnimates(el, scope.defs));
}

export function brushSVGImage(el: ZRImage, scope: BrushScope) {
    const style = el.style;
    let image = style.image;

    if (!image) {
        return;
    }
    // Only support string image in ssr renderer.

    const x = style.x || 0;
    const y = style.y || 0;

    const dw = style.width;
    const dh = style.height;

    const attrs: SVGVNodeAttrs = {
        href: image as string,
        width: dw,
        height: dh
    };
    if (x) {
        attrs.x = x;
    }
    if (y) {
        attrs.y = y;
    }

    setTransform(attrs, el.transform);
    setStyleAttrs(attrs, style, el, scope);

    return createVNode('image', el.id + '', attrs, scope.animation && createAnimates(el, scope.defs));
};

export function brushSVGTSpan(el: TSpan, scope: BrushScope) {
    const style = el.style;

    let text = style.text;
    // Convert to string
    text != null && (text += '');
    if (!text || isNaN(style.x) || isNaN(style.y)) {
        return;
    }

    // style.font has been normalized by `normalizeTextStyle`.
    const font = style.font || DEFAULT_FONT;

    // Consider different font display differently in vertial align, we always
    // set vertialAlign as 'middle', and use 'y' to locate text vertically.
    const x = style.x || 0;
    const y = adjustTextY(style.y || 0, getLineHeight(font), style.textBaseline);
    const textAlign = TEXT_ALIGN_TO_ANCHOR[style.textAlign as keyof typeof TEXT_ALIGN_TO_ANCHOR]
        || style.textAlign;

    const attrs: SVGVNodeAttrs = {
        'style': `font:${font}`,
        'dominant-baseline': 'central',
        'text-anchor': textAlign
    };
    if (text.match(/\s\s/)) {
        attrs['xml:space'] = 'preserve';
    }
    if (x) {
        attrs.x = x;
    }
    if (y) {
        attrs.y = y;
    }
    setTransform(attrs, el.transform);
    setStyleAttrs(attrs, style, el, scope);

    const childNodes = [createVNode(undefined, 'text', {}, [], text)];
    const animatesNodes = scope.animation && createAnimates(el, scope.defs);

    return createVNode('text', el.id + '', attrs, childNodes.concat(animatesNodes || []));
}

export function brush(el: Displayable, scope: BrushScope): SVGVNode {
    if (el instanceof Path) {
        return brushSVGPath(el, scope);
    }
    else if (el instanceof ZRImage) {
        return brushSVGImage(el, scope);
    }
    else if (el instanceof TSpan) {
        return brushSVGTSpan(el, scope);
    }
}

function setShadow(
    el: Displayable,
    attrs: SVGVNodeAttrs,
    scope: BrushScope
) {
    const style = el.style;
    if (hasShadow(style)) {
        const shadowKey = getShadowKey(el);
        const shadowCache = scope.shadowCache;
        let shadowId = shadowCache[shadowKey];
        if (!shadowId) {
            const globalScale = el.getGlobalScale();
            const scaleX = globalScale[0];
            const scaleY = globalScale[1];

            const offsetX = style.shadowOffsetX || 0;
            const offsetY = style.shadowOffsetY || 0;
            const blur = style.shadowBlur;
            const {opacity, color} = normalizeColor(style.shadowColor);
            const stdDx = blur / 2 / scaleX;
            const stdDy = blur / 2 / scaleY;
            const stdDeviation = stdDx + ' ' + stdDy;
            // Use a simple prefix to reduce the size
            shadowId = 's' + scope.shadowIdx++;
            scope.defs[shadowId] = createVNode(
                'filter', shadowId,
                {
                    'id': shadowId,
                    'x': '-100%',
                    'y': '-100%',
                    'width': '300%',
                    'height': '300%'
                },
                [
                    createVNode('feDropShadow', '', {
                        'dx': offsetX / scaleX,
                        'dy': offsetY / scaleY,
                        'stdDeviation': stdDeviation,
                        'flood-color': color,
                        'flood-opacity': opacity
                    })
                ]
            );
            shadowCache[shadowKey] = shadowId;
        }
        attrs.filter = getIdURL(shadowId);
    }
}

function setGradient(
    style: PathStyleProps,
    attrs: SVGVNodeAttrs,
    target: 'fill' | 'stroke',
    scope: BrushScope
) {
    const val = style[target] as GradientObject;
    let gradientTag;
    let gradientAttrs: SVGVNodeAttrs = {
        'gradientUnits': val.global
            ? 'userSpaceOnUse' // x1, x2, y1, y2 in range of 0 to canvas width or height
            : 'objectBoundingBox' // x1, x2, y1, y2 in range of 0 to 1]
    };
    if (isLinearGradient(val)) {
        gradientTag = 'linearGradient';
        gradientAttrs.x1 = val.x;
        gradientAttrs.y1 = val.y;
        gradientAttrs.x2 = val.x2;
        gradientAttrs.y2 = val.y2;
    }
    else if (isRadialGradient(val)) {
        gradientTag = 'radialGradient';
        gradientAttrs.cx = retrieve2(val.x, 0.5);
        gradientAttrs.cy = retrieve2(val.y, 0.5);
        gradientAttrs.r = retrieve2(val.r, 0.5);
    }
    else {
        logError('Illegal gradient type.');
        return;
    }

    const colors = val.colorStops;

    const colorStops = [];
    for (let i = 0, len = colors.length; i < len; ++i) {
        const offset = round4(colors[i].offset) * 100 + '%';

        const stopColor = colors[i].color;
        // Fix Safari bug that stop-color not recognizing alpha #9014
        const {color, opacity} = normalizeColor(stopColor);

        const stopsAttrs: SVGVNodeAttrs = {
            'offset': offset
        };
        // stop-color cannot be color, since:
        // The opacity value used for the gradient calculation is the
        // *product* of the value of stop-opacity and the opacity of the
        // value of stop-color.
        // See https://www.w3.org/TR/SVG2/pservers.html#StopOpacityProperty

        stopsAttrs['stop-color'] = color;
        if (opacity < 1) {
            stopsAttrs['stop-opacity'] = opacity;
        }
        colorStops.push(
            createVNode('stop', i + '', stopsAttrs)
        );
    }

    // Use the whole html as cache key.
    const gradientVNode = createVNode(gradientTag, '', gradientAttrs, colorStops);
    const gradientKey = vNodeToString(gradientVNode);
    const gradientCache = scope.gradientCache;
    let gradientId = gradientCache[gradientKey];
    if (!gradientId) {
        gradientId = 'g' + scope.gradientIdx++;
        gradientCache[gradientKey] = gradientId;

        gradientAttrs.id = gradientId;
        scope.defs[gradientId] = createVNode(
            gradientTag, gradientId, gradientAttrs, colorStops
        );
    }

    attrs[target] = getIdURL(gradientId);
}

function setPattern(
    el: Displayable,
    attrs: SVGVNodeAttrs,
    target: 'fill' | 'stroke',
    scope: BrushScope
) {
    const val = el.style[target] as ImagePatternObject | SVGPatternObject;
    const patternAttrs: SVGVNodeAttrs = {
        'patternUnits': 'userSpaceOnUse'
    };
    let child: SVGVNode;
    if (isImagePattern(val)) {
        let imageWidth = val.imageWidth;
        let imageHeight = val.imageHeight;
        let imageSrc;
        const patternImage = val.image;
        if (typeof patternImage === 'string') {
            imageSrc = patternImage;
        }
        else if (patternImage instanceof HTMLImageElement) {
            imageSrc = patternImage.src;
        }
        else if (patternImage instanceof HTMLCanvasElement) {
            imageSrc = patternImage.toDataURL();
        }

        if (typeof Image === 'undefined') {
            const errMsg = 'Image width/height must been given explictly in svg-ssr renderer.';
            assert(imageWidth, errMsg);
            assert(imageHeight, errMsg);
        }
        else if (imageWidth == null || imageHeight == null) {
            // TODO
            const setSizeToVNode = (vNode: SVGVNode, img: ImageLike) => {
                if (vNode) {
                    const svgEl = vNode.elm as SVGElement;
                    const width = (vNode.attrs.width = imageWidth || img.width);
                    const height = (vNode.attrs.height = imageHeight || img.height);
                    if (svgEl) {
                        svgEl.setAttribute('width', width as any);
                        svgEl.setAttribute('height', height as any);
                    }
                }
            };
            const createdImage = createOrUpdateImage(
                imageSrc, null, el, (img) => {
                    setSizeToVNode(patternVNode, img);
                    setSizeToVNode(child, img);
                }
            );
            if (createdImage && createdImage.width && createdImage.height) {
                // Loaded before
                imageWidth = imageWidth || createdImage.width;
                imageHeight = imageHeight || createdImage.height;
            }
        }

        // TODO Only support string url
        child = createVNode(
            'image',
            'img',
            {
                href: val.image as string,
                width: imageWidth,
                height: imageHeight
            }
        );
        patternAttrs.width = imageWidth;
        patternAttrs.height = imageHeight;
    }
    else if (val.svgElement) {  // Only string supported in SSR.
        // TODO it's not so good to use textContent as innerHTML
        child = val.svgElement;
        patternAttrs.width = val.svgWidth;
        patternAttrs.height = val.svgHeight;
    }
    if (!child) {
        return;
    }

    const x = val.x || 0;
    const y = val.y || 0;
    const rotation = (val.rotation || 0) / Math.PI * 180;
    const scaleX = val.scaleX || 1;
    const scaleY = val.scaleY || 1;
    patternAttrs.patternTransform = `translate(${x},${y}) rotate(${rotation}) scale(${scaleX},${scaleY})`;

    // Use the whole html as cache key.
    const patternVNode = createVNode(
        'pattern',
        '',
        patternAttrs,
        [child]
    );
    const patternKey = vNodeToString(patternVNode);
    const patternCache = scope.patternCache;
    let patternId = patternCache[patternKey];
    if (!patternId) {
        patternId = 'p' + scope.patternIdx++;
        patternCache[patternKey] = patternId;
        patternAttrs.id = patternId;
        scope.defs[patternId] = createVNode(
            'pattern',
            patternId,
            patternAttrs,
            [child]
        );
    }

    attrs[target] = getIdURL(patternId);
}

export function setClipPath(
    clipPath: Path,
    attrs: SVGVNodeAttrs,
    scope: BrushScope
) {
    const {clipPathCache, defs} = scope;
    let clipPathId = clipPathCache[clipPath.id];
    if (!clipPathId) {
        clipPathId = 'c' + scope.clipPathIdx++;
        const clipPathAttrs: SVGVNodeAttrs = {
            id: clipPathId
        };

        clipPathCache[clipPath.id] = clipPathId;
        defs[clipPathId] = createVNode(
            'clipPath', clipPathId, clipPathAttrs,
            [brushSVGPath(clipPath, scope)]
        );
    }
    attrs['clip-path'] = getIdURL(clipPathId);
}
