<template>
  <div id="app-root">
    <ChatView />
  </div>
</template>

<script setup>
import ChatView from './views/ChatView.vue'
</script>

<style>
* {
  margin: 0;
  padding: 0;
  box-sizing: border-box;
}

body, html, #app, #app-root {
  margin: 0;
  padding: 0;
  height: 100vh;
  width: 100vw;
  overflow: hidden;
}
</style>
