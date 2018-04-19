#!/usr/bin/env coffee

fs = require 'fs-extra'
path = require 'path'
{DOMParser} = require 'xmldom'
{exec} = require 'child_process'
pug = require 'pug'
less = require 'less'
chokidar = require 'chokidar'
commander = require 'commander'
colors = require 'colors/safe'

colors.setTheme 
  '变更': 'blue',
  '删除': 'bgMagenta',
  '执行': 'blue',
  '信息': 'grey',
  '创建': 'green',
  '监听': 'magenta',
  '错误': 'red',
  '测试': 'red',
  '拷贝': 'yellow',
  '编译': 'green',
  '写入': 'green'

# 处理 npm 包
handleNPM = (jsCode) -> 
  deps = []
  jsCode.replace /require\(['"](.*?)['"]\)/, (a, b) -> deps.push b
  
  deps.forEach (dep) ->
    isNPM = dep.includes '/npm'

    if isNPM
      npmName = path.basename(dep).split('.')[0]
      distPath = path.join modulesPath, npmName, "dist/#{npmName}.js"
      indexPath = path.join modulesPath, npmName, 'index.js'
      npmNamePath = path.join modulesPath, npmName, "#{npmName}.js"
    
      hasNPM = false
      [distPath, indexPath, npmNamePath].some (p) ->
        if fs.existsSync p
          copyFile p, path.join npmPath, "#{npmName}.js"
          hasNPM = true
      
      if not hasNPM
        error "没有找到#{dep}"

# 获取版本号
getVersion = () -> 
  packagePath = path.resolve __dirname, 'package.json'
  JSON.parse(fs.readFileSync packagePath).version

# 获取当前时间
datetime = (date = new Date, formate = 'HH:mm:ss') ->
  fn = (d) -> ('0' + d).slice -2
  formats = 
    YYYY: date.getFullYear,
    MM: fn(date.getMonth + 1),
    DD: fn(date.getDate()),
    HH: fn(date.getHours()),
    mm: fn(date.getMinutes()),
    ss: fn(date.getSeconds())
  
  formate.replace /([a-z])\1+/ig, (a) -> formats[a] || a

# 打日志
log = (msg, type, showTime = true) -> 
  time = if showTime then colors.gray("#{datetime()}") else ''
  
  if type is 'ERROR'
    console.error time + colors.red '[Error]' + msg
  else if type is 'WARNING'
    console.error time + colors.yellow '[Warning]' + msg
  else 
    fn = if colors[type] then colors[type] else colors['info']
    console.log time + fn "#{type}" + msg  

error = (msg) -> log msg, 'ERROR'
warning = (msg) -> log msg, 'WARNING'

# 创建文件
createFile = (f, body) ->
  arr = f.split '/'
  len = arr.length
  i = 0
  a = '/'

  while (b = arr.shift()) isnt undefined
    i++
    a = path.join a, b
    if body and (i is len)
      fs.writeFileSync a, body.toString()
    else
      if not fs.existsSync a
        fs.mkdirSync a

# 复制文件
copyFile = (f1, f2) -> 
  new Promise (resolve, reject) ->
    fs.copy f1, f2, (err) ->
      if err
        reject err
      else
        resolve()

# 删除文件
removeFile = (f) ->
  new Promise (resolve, reject) ->
    exec "rm -rf #{f}"
      .stdout
      .on 'end', () -> resolve()

# 深度遍历目录
walk = (dir, callback) ->
  fs.readdirSync dir
    .forEach (item) ->
      return false if item[0] is '.'

      f = path.join dir, item
      if fs.statSync(f).isDirectory()
        walk f, callback
      else 
        callback(f)

makeNodesArray = (nodes) -> [].slice.call nodes || []

# 拆解 wpy 文件
splitWpy = (filePath) -> 
  content = fs.readFileSync(filePath).toString()
  doc = (new DOMParser).parseFromString content
  tags = 'style,wxss,less,template,script,config'.split ','

  codes = {}
  tags.forEach (tag) -> codes[tag] = ''

  if doc
    makeNodesArray(doc.childNodes).forEach (node) -> 
      nodeName = node.nodeName

      if tags.includes nodeName
        lang = node.getAttribute 'lang'

        if nodeName is 'style'
          if lang is 'less'
            nodeName = 'less'
          else 
            nodeName = 'wxss'
        
        makeNodesArray(node.childNodes).forEach (node2) -> 
          codes[nodeName] = codes[nodeName] || '' + node2.toString()
  
  # 处理 js 代码
  handleNPM(codes.script) if codes.script

  # 处理 pug 代码
  codes.template = (pug.compile codes.template)({}) if codes.template
  
  # 如果没有 less 代码
  return Promise.resolve codes if not codes.less

  # 如果有 less 代码
  new Promise (resolve, reject) ->
    process.chdir path.dirname filePath

    # 清除 less 缓存
    if (less.environment?.fileManagers?)
      less.environment.fileManagers.forEach (manager) ->
        manager.contents = {} if manager.contents
    
    # 编译 less
    less.render codes.less
      .then (output) ->
        process.chdir rootPath
        # 添加依赖
        output.imports.forEach (importPath) ->
          lessPath = path.join (path.dirname filePath), importPath
          lessDepTable[lessPath] = filePath
        
        codes.less = output.css
        codes.wxss = (codes.wxss || '') + codes.less
        resolve codes
      .catch (e) ->
        process.chdir rootPath
        error e
        reject e

# 根据 codes 生成  dist/pages/page/page.wxml, page.wxss, page.js, page.json
createDistPage = (filePath, codes) ->
  relativePath = path.relative srcPath, filePath
  fileDistPath = path.join distPath, relativePath
  fileDistPathName = fileDistPath.split('.')[0]

  createFile fileDistPathName + '.wxml', codes.template if codes.template
  createFile fileDistPathName + '.js', codes.script if codes.script
  createFile fileDistPathName + '.wxss', codes.wxss if codes.wxss
  createFile fileDistPathName + '.json', codes.config if codes.config

handleWpy = (filePath) ->
  splitWpy filePath
    .then (codes) -> createDistPage filePath, codes

handleFile = (filePath, isWatch) ->
  extname = path.extname filePath
  relativePath = path.relative srcPath, filePath

  if extname is '.wpy'
    log '文件：' + relativePath, '编译'
    handleWpy filePath
  
  else if extname is '.js'
    log '文件:' + relativePath, '编译'
    copyFile filePath, (path.join distPath, relativePath)
    handleNPM (fs.readFileSync filePath).toString()

  else if extname is '.less'
    if isWatch
      log '文件：' + relativePath, '变更'
      handleFile lessDepTable[filePath] if filePath of lessDepTable
  
  else 
    log '文件：' + relativePath, '拷贝'
    copyFile filePath, (path.join distPath, relativePath)

watch = () ->
  watchReady = false
  chokidar.watch srcPath, {}
    .on 'all', (evt, filePath) ->
      handleFile filePath, true if (evt is 'change' or evt is 'add') and watchReady
    .on 'ready', () ->
      watchReady = true
      log '开始监听文件改动...', '监听'

handle = () ->
  removeFile distPath
    .then () ->
      walk srcPath, (filePath) -> handleFile filePath

# 主流程
rootPath = process.cwd()
srcPath = path.join rootPath, 'src'
distPath = path.join rootPath, 'dist'
npmPath = path.join distPath, 'npm'
modulesPath = path.join rootPath, 'node_modules'

# 依赖表{.less : .wpy}
lessDepTable = {}

commander.usage '[command] <options ...>'
commander.option '-v, --version', '显示版本号', () -> console.log getVersion()
commander.option '-w, --watch', '监听文件改动'

commander
  .command 'build'
  .description '编译项目'
  .action () ->
    handle()
    watch() if commander.watch

commander.parse process.argv
